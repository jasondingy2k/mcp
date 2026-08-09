#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema, Tool} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { randomUUID } from "crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { loadEnvFile } from './env.js';
import { makeLogger } from './logging.js';
import { makeToolError } from './errors.js';
import { redactSensitive } from './redact.js';
import { readResearchConfig, runResearch } from './research.js';
import {
  parseApiKeys,
  parseKeyWeight,
  WeightedRoundRobin,
  retryOverPool,
  shouldRetryNextKey,
  type KeyCandidate,
} from './keypool.js';
export * from './research.js';
export { redactSensitive };
export { parseEnvValue, loadEnvFile } from './env.js';
export { makeToolError } from './errors.js';
export { makeLogger } from './logging.js';
export { parseApiKeys, parseKeyWeight, WeightedRoundRobin, retryOverPool, shouldRetryNextKey } from './keypool.js';

// .env 约定：启动时只加载一次。
loadEnvFile();

// ---- 多 key 加权负载均衡（多 key 方案 2026-08-08 §5）----
// TAVILY_API_KEY / EXA_API_KEY 逗号分隔多 key，N 不写死；权重默认 1000/1400（env 可覆盖）。
const TAVILY_KEYS = parseApiKeys(process.env.TAVILY_API_KEY);
const EXA_KEYS = parseApiKeys(process.env.EXA_API_KEY || process.env.EXASEARCH_API_KEY);
const TAVILY_KEY_WEIGHT = parseKeyWeight(process.env.TAVILY_KEY_WEIGHT, 1000);
const EXA_KEY_WEIGHT = parseKeyWeight(process.env.EXA_KEY_WEIGHT, 1400);
// keyless 判定与现网一致：无任何 Tavily key → 走 Tavily keyless（extract/crawl/map 依赖）。
const IS_KEYLESS = TAVILY_KEYS.length === 0;
// search 全池（Tavily + Exa）；extract/crawl/map 仅 Tavily 池。
const SEARCH_CANDIDATES: KeyCandidate[] = [
  ...TAVILY_KEYS.map((key) => ({ provider: 'tavily' as const, key, weight: TAVILY_KEY_WEIGHT })),
  ...EXA_KEYS.map((key) => ({ provider: 'exa' as const, key, weight: EXA_KEY_WEIGHT })),
];
const TAVILY_CANDIDATES: KeyCandidate[] = SEARCH_CANDIDATES.filter((c) => c.provider === 'tavily');
const searchPool = new WeightedRoundRobin(SEARCH_CANDIDATES);
const tavilyPool = new WeightedRoundRobin(TAVILY_CANDIDATES);

const HUMAN_ID = process.env.TAVILY_HUMAN_ID;
const SESSION_ID = randomUUID();

// ---- 静默日志 + 错误前缀 ----
const log = makeLogger('deepseek-websearch', 'DEEPSEEK_WEBSEARCH_LOG_LEVEL');
export const toolError = makeToolError('deepseek-websearch');

// ---- Tavily→Exa search 池化（多 key 加权负载均衡方案 2026-08-08 §5）----
const SEARCH_PROVIDER_TIMEOUT_MS = 30000;       // per-provider HTTP budget
const SEARCH_FAILOVER_TOTAL_TIMEOUT_MS = 60000; // total Tavily→Exa sequence budget
const SEARCH_TRANSIENT_RETRIES = 1;             // 同 key 5xx 再试次数（Exa 借鉴方案 §2 F）
const SEARCH_TRANSIENT_BASE_DELAY_MS = 500;
const EXTRACT_TIMEOUT_MS = 120000;              // extract: minute-level budget (multi-URL)
const MAP_TIMEOUT_MS = 30000;                   // map: seconds-level budget
const CRAWL_SUBMIT_TIMEOUT_MS = 60000;          // crawl: POST /crawl submit budget
const CRAWL_POLL_INTERVAL_MS = 3000;            // crawl: initial poll interval
const CRAWL_MAX_POLL_INTERVAL_MS = 10000;       // crawl: backoff cap
const CRAWL_POLL_BACKOFF_FACTOR = 1.5;          // crawl: backoff factor (research parity)
const CRAWL_TOTAL_TIMEOUT_MS = 300000;          // crawl: total submit+poll budget (5 min)

// ---- research 主代理配置（RESEARCH_*，改造方案 2026-08-08 §5）----
// 类型/常量/读取函数在 research.ts（单一实现）；此处 loadEnvFile 之后实例化（env 就绪）。
export const researchConfig = readResearchConfig();
log('info', `research 主代理:${researchConfig.model} @ ${researchConfig.baseUrl}`);

export type SearchFailureKind = 'quota' | 'rate' | 'auth' | 'error';
export class SearchProviderFailure extends Error {
  http: number | null;
  kind: SearchFailureKind;
  data: any; // 透传原始响应体（供 keyless envelope 识别，P2-6）
  constructor(message: string, http: number | null, kind: SearchFailureKind, data: any = null) {
    super(message);
    this.name = 'SearchProviderFailure';
    this.http = http;
    this.kind = kind;
    this.data = data;
  }
}

// Classify a non-2xx status into a failure kind: 5xx/network → error;
// 401/403 → auth; 402/429 → quota/rate.
// 旧 shouldFallbackToExa（仅 error 切 Exa）已拆除：多 key 方案改为全 kind 换下一 key
// （shouldRetryNextKey 恒 true，见 keypool.ts）。
export function classifyNonSuccess(status: number, text: string): SearchFailureKind {
  const lower = text.toLowerCase();
  if (status >= 500) return 'error';
  if (!(400 <= status && status < 500)) return 'error';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) {
    return ['credit', 'quota', 'payment', 'insufficient', 'usage limit']
      .some((n) => lower.includes(n)) ? 'quota' : 'rate';
  }
  const quotaHints = ['quota', 'credit', 'insufficient', 'payment required', 'usage limit', 'out of credits', 'no credits'];
  if (quotaHints.some((n) => lower.includes(n))) return 'quota';
  if (lower.includes('rate limit') || lower.includes('too many requests')) return 'rate';
  return 'error';
}

function raiseForStatus(provider: string, status: number, text: string, data: any = null): void {
  if (status >= 200 && status < 300) return;
  const kind = classifyNonSuccess(status, text);
  throw new SearchProviderFailure(
    `${provider} ${kind}: HTTP ${status}: ${text.slice(0, 200)}`,
    status,
    kind,
    data
  );
}

// Validate a provider 2xx payload; malformed bodies raise so the Exa fallback
// path is taken (mirrors agent-websearch A3). Empty 2xx is accepted, not an error.
export function validateSearchPayload(data: any, provider: string): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SearchProviderFailure(`${provider} malformed: body is not an object`, null, 'error');
  }
  const raw = data.results;
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    throw new SearchProviderFailure(`${provider} malformed: results is not a list`, null, 'error');
  }
  if (raw.length > 0 && raw.every((item: any) => !item || typeof item !== 'object')) {
    throw new SearchProviderFailure(`${provider} malformed: all result items invalid`, null, 'error');
  }
  // 混合条目（合法对象 + null）在校验层不抛；渲染层必须 skip 非对象，避免 TypeError
}

/** Exa category: 从 query 解析 `category:people` 等（对齐官方 MCP，不扩 schema）。 */
const EXA_CATEGORY_RE =
  /\bcategory:(company|publication|news|pdf|github|personal\s*site|people|financial report)\b/i;

/**
 * 剥 `category:` token。cleaned 为空时不回落原串（由 search 入口 ValidationError）。
 * search 在进池前统一调用；Tavily 只用干净 query；Exa 另带 category 参数。
 */
export function parseExaCategory(query: string): { query: string; category?: string } {
  const m = query.match(EXA_CATEGORY_RE);
  if (!m) return { query };
  const category = m[1].toLowerCase().replace(/\s+/g, ' ');
  const cleaned = query.replace(m[0], '').replace(/\s+/g, ' ').trim();
  return { query: cleaned, category };
}

/** max_results 钳制到 schema 的 1–20（缺省/非法 → fallback）。 */
export function clampMaxResults(value: unknown, fallback = 5): number {
  const n = typeof value === 'number' ? value : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(20, Math.max(1, Math.floor(n)));
}

/** extract：无成功 results 且有 failed_results → 全失败。 */
export function isExtractTotalFailure(response: TavilyResponse): boolean {
  const results = Array.isArray(response.results) ? response.results : [];
  const failed = Array.isArray(response.failed_results) ? response.failed_results : [];
  return results.length === 0 && failed.length > 0;
}

/** Exa 单条结果正文上限（API text.maxCharacters + 映射层双保险）。 */
export const EXA_CONTENT_MAX_CHARS = 1200;

// Map the search params that Exa understands; the rest are ignored.
// 轻量：显式 text 封顶 + highlights 封顶；禁止只开 highlights:true（实测仍可能带回全文 text）。
// category 优先用上游已剥好的 params.category；否则再从 query 解析（直连/单测）。
export function buildExaPayload(params: any): Record<string, any> {
  let query = String(params.query ?? '');
  let category: string | undefined =
    typeof params.category === 'string' && params.category ? params.category : undefined;
  if (!category) {
    const parsed = parseExaCategory(query);
    query = parsed.query;
    category = parsed.category;
  }
  const payload: Record<string, any> = {
    query,
    numResults: clampMaxResults(params.max_results),
    type: 'auto',
    contents: {
      text: { maxCharacters: EXA_CONTENT_MAX_CHARS },
      highlights: { maxCharacters: EXA_CONTENT_MAX_CHARS },
    },
  };
  if (category) payload.category = category;
  if (Array.isArray(params.include_domains) && params.include_domains.length > 0) {
    payload.includeDomains = params.include_domains;
  }
  if (Array.isArray(params.exclude_domains) && params.exclude_domains.length > 0) {
    payload.excludeDomains = params.exclude_domains;
  }
  if (params.start_date) payload.startPublishedDate = params.start_date;
  if (params.end_date) payload.endPublishedDate = params.end_date;
  return payload;
}

function clampExaContent(text: string, max: number = EXA_CONTENT_MAX_CHARS): string {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// Map an Exa payload onto the TavilyResponse shape so the existing
// formatResults() renders it unchanged. Prefer highlights; always clamp.
export function mapExaResultsToTavily(data: any): TavilyResponse {
  const raw = Array.isArray(data.results) ? data.results : [];
  const results = raw
    .filter((item: any) => item && typeof item === 'object')
    .map((item: any) => {
      let contents = '';
      if (Array.isArray(item.highlights) && item.highlights.length > 0) {
        contents = item.highlights.join(' [...] ');
      } else {
        contents = item.text || item.summary || '';
      }
      return {
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        content: clampExaContent(String(contents ?? '')),
        score: typeof item.score === 'number' ? item.score : 0,
        id: item.id ? String(item.id) : '',
      };
    });
  return { query: String(data.query ?? ''), results };
}

/** agent 常把 number/boolean 当 query、数字串当 max_results、单 URL 当 urls。 */
export function coerceSearchArgs(args: any): any {
  if (!args || typeof args !== 'object') return args;
  const out: any = { ...args };
  if (typeof out.query === 'number' || typeof out.query === 'boolean') {
    out.query = String(out.query);
  }
  if (typeof out.query === 'string') out.query = out.query.trim();
  if (typeof out.max_results === 'string' && /^\d+$/.test(out.max_results.trim())) {
    out.max_results = Number(out.max_results.trim());
  }
  out.include_domains = coerceStringList(out.include_domains);
  out.exclude_domains = coerceStringList(out.exclude_domains);
  return out;
}

export function coerceExtractArgs(args: any): any {
  if (!args || typeof args !== 'object') return args;
  const out: any = { ...args };
  out.urls = coerceUrlList(out.urls);
  return out;
}

/**
 * Tavily search 最优解默认（方案 2026-08-09）：
 * - include_answer: "basic"（显式 false/0/"false" 可关）
 * - chunks_per_source: 2（1–3；显式保留）
 * 不设 auto_parameters。不覆盖调用方已传值。
 */
export function applySearchDefaults(params: any): any {
  if (!params || typeof params !== 'object') return params;
  const out: any = { ...params };

  if (out.include_answer === undefined) {
    out.include_answer = 'basic';
  } else if (out.include_answer === false || out.include_answer === 0 || out.include_answer === 'false') {
    out.include_answer = false;
  } else if (out.include_answer === true || out.include_answer === 'true') {
    out.include_answer = 'basic';
  }
  // "basic" | "advanced" | false 原样保留

  if (out.chunks_per_source === undefined) {
    out.chunks_per_source = 2;
  } else if (typeof out.chunks_per_source === 'string' && /^\d+$/.test(out.chunks_per_source.trim())) {
    out.chunks_per_source = Number(out.chunks_per_source.trim());
  }
  if (typeof out.chunks_per_source === 'number') {
    out.chunks_per_source = Math.min(3, Math.max(1, Math.floor(out.chunks_per_source)));
  }

  return out;
}

/** extract：有 query 重排时默认 chunks_per_source=3（1–5）。 */
export function applyExtractDefaults(params: any): any {
  if (!params || typeof params !== 'object') return params;
  const out: any = { ...params };
  const hasQuery = typeof out.query === 'string' && out.query.trim().length > 0;
  if (hasQuery && out.chunks_per_source === undefined) {
    out.chunks_per_source = 3;
  } else if (typeof out.chunks_per_source === 'string' && /^\d+$/.test(out.chunks_per_source.trim())) {
    out.chunks_per_source = Number(out.chunks_per_source.trim());
  }
  if (typeof out.chunks_per_source === 'number') {
    out.chunks_per_source = Math.min(5, Math.max(1, Math.floor(out.chunks_per_source)));
  }
  return out;
}

function coerceStringList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  }
  if (typeof v === 'string') {
    return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return undefined;
}

function coerceUrlList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) {
          return parsed.map((x) => String(x).trim()).filter((s) => s.length > 0);
        }
      } catch {
        /* fall through: treat as single URL */
      }
    }
    return [t];
  }
  return [String(v)];
}

/** 同 key 瞬态 5xx：最多再试 SEARCH_TRANSIENT_RETRIES 次，再失败交给换 key。 */
export function isTransientHttpStatus(status: unknown): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export async function retryTransientHttp<T>(
  fn: () => Promise<T>,
  maxRetries: number = SEARCH_TRANSIENT_RETRIES,
  baseDelayMs: number = SEARCH_TRANSIENT_BASE_DELAY_MS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      if (!isTransientHttpStatus(status) || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

function bodyText(data: any): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  return redactSensitive(text);
}

// Track which provider the current search attempt is on for timeout messages
// (request-scoped via toProviderFailure phase arg — not a module global).
function toProviderFailure(
  provider: string,
  err: any,
  phase: 'tavily' | 'exa' | null = null
): SearchProviderFailure {
  if (err instanceof SearchProviderFailure) return err;
  if (err?.code === 'ERR_CANCELED' || axios.isCancel(err)) {
    return new SearchProviderFailure(
      `Search timed out after ${SEARCH_FAILOVER_TOTAL_TIMEOUT_MS / 1000}s（卡在 ${phase ?? 'unknown'}）`,
      null, 'error'
    );
  }
  if (err?.code === 'ECONNABORTED') {
    return new SearchProviderFailure(`${provider} timeout`, null, 'error');
  }
  if (err?.response) {
    try {
      raiseForStatus(provider, err.response.status, bodyText(err.response.data), err.response.data);
    } catch (classified) {
      return classified as SearchProviderFailure;
    }
    return new SearchProviderFailure(
      `${provider} HTTP ${err.response.status}`,
      err.response.status,
      'error',
      err.response.data
    );
  }
  return new SearchProviderFailure(`${provider} network: ${err?.message ?? err}`, null, 'error');
}


interface TavilyResponse {
  // Response structure from Tavily API
  query: string;
  follow_up_questions?: Array<string>;
  answer?: string;
  images?: Array<string | {
    url: string;
    description?: string;
  }>;
  results?: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
    raw_content?: string;
    favicon?: string;
    id: string;
  }>;
  /** extract 部分 URL 失败时 Tavily 返回；search 通常无此字段 */
  failed_results?: Array<{
    url?: string;
    error?: string;
  } | string>;
  /** 内部：search 实际命中的引擎；formatResults 读后输出 Provider 行，不进 answer */
  _provider?: 'tavily' | 'exa';
}

interface TavilyCrawlResponse {
  base_url: string;
  results?: Array<{
    url: string;
    raw_content: string;
    favicon?: string;
  }>;
  response_time: number;
}


interface TavilyMapResponse {
  base_url: string;
  results?: string[];
  response_time: number;
}

class TavilyClient {
  // Core client properties
  private server: Server;
  private axiosInstance;
  private baseURLs = {
    search: 'https://api.tavily.com/search',
    extract: 'https://api.tavily.com/extract',
    crawl: 'https://api.tavily.com/crawl',
    map: 'https://api.tavily.com/map',
  };

  private docsURLs: Record<string, string> = {
    search: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
    extract: 'https://docs.tavily.com/documentation/api-reference/endpoint/extract',
    crawl: 'https://docs.tavily.com/documentation/api-reference/endpoint/crawl',
    map: 'https://docs.tavily.com/documentation/api-reference/endpoint/map',
  };

  constructor() {
    this.server = new Server(
      {
        name: "deepseek-websearch",
        version: "0.2.22",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // 不再在 axios.create 写死单个 Authorization/keyless（多 key 方案 §6 步骤 4）：
    // 通用头保留；Tavily 请求每次按所选 key 注入 Authorization / keyless 头。
    this.axiosInstance = axios.create({
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'X-Session-Id': SESSION_ID,
        ...(HUMAN_ID ? { 'X-Human-Id': HUMAN_ID } : {}),
      }
    });

    if (IS_KEYLESS) {
      log('info', 'No TAVILY_API_KEY set; running in keyless mode. Search and extract are available; other tools will explain that an API key is required.');
    }

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error: any) => {
      log('error', `[MCP Error] ${error?.message ?? error}`);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private getDefaultParameters(): Record<string, any> {
    /**Get default parameter values from environment variable.
     * 
     * The environment variable DEFAULT_PARAMETERS should contain a JSON string 
     * with parameter names and their default values.
     * Example: DEFAULT_PARAMETERS='{"search_depth":"basic","include_images":true}'
     * 
     * Returns:
     *   Object with default parameter values, or empty object if env var is not present or invalid.
     */
    try {
      const parametersEnv = process.env.DEFAULT_PARAMETERS;
      
      if (!parametersEnv) {
        return {};
      }
      
      // Parse the JSON string
      const defaults = JSON.parse(parametersEnv);
      
      if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
        log('warn', `DEFAULT_PARAMETERS is not a valid JSON object: ${parametersEnv}`);
        return {};
      }
      
      return defaults;
    } catch (error: any) {
      log('warn', `Failed to parse DEFAULT_PARAMETERS as JSON: ${error.message}`);
      return {};
    }
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Define available tools: deepseek_search and deepseek_extract
      const tools: Tool[] = [
        {
          name: "deepseek_search",
          description: "Live web search. query required. search_depth basic(1 credit,default)|advanced(2). For URLs use deepseek_extract; deep report use deepseek_research.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query"
              },
              search_depth: {
                type: "string",
                enum: ["basic","advanced","fast","ultra-fast"],
                description: "basic|advanced; credit 1|2",
                default: "basic"
              },
              topic: {
                type: "string",
                enum: ["general", "news", "finance"],
                description: "news/finance for time-sensitive; country forces general"
              },
              time_range: {
                type: "string",
                description: "Last day/week/month/year",
                enum: ["day", "week", "month", "year"]
              },
              start_date: {
                type: "string",
                description: "After YYYY-MM-DD"
              },
              end_date: {
                type: "string",
                description: "Before YYYY-MM-DD"
              },
              max_results: {
                type: "number",
                description: "Max results (1–20)",
                default: 5,
                minimum: 1,
                maximum: 20
              },
              chunks_per_source: {
                type: "number",
                description: "Chunks per URL (1–3; default 2)",
                minimum: 1,
                maximum: 3
              },
              include_answer: {
                description: "LLM answer from results (default basic; false to disable)"
              },
              include_raw_content: {
                type: "boolean",
                description: "Full cleaned page content (large)"
              },
              include_domains: {
                type: "array",
                items: { type: "string" },
                description: "Restrict to these domains"
              },
              exclude_domains: {
                type: "array",
                items: { type: "string" },
                description: "Exclude these domains"
              },
              country: {
                type: "string",
                description: "full country name; not ISO code"
              },
              exact_match: {
                type: "boolean",
                description: "Only exact quoted phrase(s)"
              }
            },
            required: ["query"]
          }
        },
        {
          name: "deepseek_extract",
          description: "Extract page content from URLs. After search when snippets thin.",
          inputSchema: {
            type: "object",
            properties: {
              urls: {
                type: "array",
                items: { type: "string" },
                description: "URLs to extract"
              },
              extract_depth: {
                type: "string",
                enum: ["basic", "advanced"],
                description: "advanced for LinkedIn/protected/tables",
                default: "basic"
              },
              format: {
                type: "string",
                enum: ["markdown", "text"],
                description: "Output format",
                default: "markdown"
              },
              query: {
                type: "string",
                description: "Rerank chunks by relevance"
              },
              chunks_per_source: {
                type: "number",
                description: "Chunks per URL when query set (1–5; default 3)",
                minimum: 1,
                maximum: 5
              }
            },
            required: ["urls"]
          }
        },
        {
          name: "deepseek_crawl",
          description: "Crawl site for page content (async, ~5 min wall). URL list only → deepseek_map.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Root URL"
              },
              max_depth: {
                type: "integer",
                description: "Max depth",
                default: 1,
                minimum: 1
              },
              max_breadth: {
                type: "integer",
                description: "Max links per level",
                default: 20,
                minimum: 1
              },
              limit: {
                type: "integer",
                description: "Max total links",
                default: 50,
                minimum: 1
              },
              instructions: {
                type: "string",
                description: "Which pages to return"
              },
              select_paths: {
                type: "array",
                items: { type: "string" },
                description: "Path regex (e.g. /docs/.*)"
              },
              select_domains: {
                type: "array",
                items: { type: "string" },
                description: "Domain regex"
              },
              allow_external: {
                type: "boolean",
                description: "Include external links",
                default: true
              },
              extract_depth: {
                type: "string",
                enum: ["basic", "advanced"],
                description: "advanced: more data, slower",
                default: "basic"
              },
              format: {
                type: "string",
                enum: ["markdown","text"],
                description: "markdown or text",
                default: "markdown"
              },
            },
            required: ["url"]
          }
        },
        {
          name: "deepseek_map",
          description: "List site URLs from base URL. Content → deepseek_crawl or deepseek_extract.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Root URL"
              },
              max_depth: {
                type: "integer",
                description: "Max depth",
                default: 1,
                minimum: 1
              },
              max_breadth: {
                type: "integer",
                description: "Max links per level",
                default: 20,
                minimum: 1
              },
              limit: {
                type: "integer",
                description: "Max total links",
                default: 50,
                minimum: 1
              },
              instructions: {
                type: "string",
                description: "Which pages to return"
              },
              select_paths: {
                type: "array",
                items: { type: "string" },
                description: "Path regex (e.g. /docs/.*)"
              },
              select_domains: {
                type: "array",
                items: { type: "string" },
                description: "Domain regex"
              },
              allow_external: {
                type: "boolean",
                description: "Include external links",
                default: true
              }
            },
            required: ["url"]
          }
        },
        {
          name: "deepseek_research",
          description: "Multi-step research report (capped cost). Quick fact → deepseek_search.",
          inputSchema: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "Research task description"
              }
            },
            required: ["input"]
          }
        },
      ];
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        let response: TavilyResponse;
        const rawArgs = request.params.arguments ?? {};

        switch (request.params.name) {
          case "deepseek_search": {
            const args = coerceSearchArgs(rawArgs);
            // If country is set, ensure topic is general
            if (args.country) {
              args.topic = "general";
            }
            
            response = await this.search({
              query: args.query,
              search_depth: args.search_depth,
              topic: args.topic,
              time_range: args.time_range,
              max_results: args.max_results,
              chunks_per_source: args.chunks_per_source,
              include_answer: args.include_answer,
              include_images: args.include_images,
              include_image_descriptions: args.include_image_descriptions,
              include_raw_content: args.include_raw_content,
              include_domains: Array.isArray(args.include_domains) ? args.include_domains : [],
              exclude_domains: Array.isArray(args.exclude_domains) ? args.exclude_domains : [],
              country: args.country,
              include_favicon: args.include_favicon,
              start_date: args.start_date,
              end_date: args.end_date,
              exact_match: args.exact_match
            });
            break;
          }
          
          case "deepseek_extract": {
            const args = applyExtractDefaults(coerceExtractArgs(rawArgs));
            response = await this.extract({
              urls: args.urls,
              extract_depth: args.extract_depth,
              include_images: args.include_images,
              format: args.format,
              include_favicon: args.include_favicon,
              query: args.query,
              chunks_per_source: args.chunks_per_source,
            });
            break;
          }

          case "deepseek_crawl": {
            const args = rawArgs;
            const crawlResponse = await this.crawl({
              url: args.url,
              max_depth: args.max_depth,
              max_breadth: args.max_breadth,
              limit: args.limit,
              instructions: args.instructions,
              select_paths: Array.isArray(args.select_paths) ? args.select_paths : [],
              select_domains: Array.isArray(args.select_domains) ? args.select_domains : [],
              allow_external: args.allow_external,
              extract_depth: args.extract_depth,
              format: args.format,
              include_favicon: args.include_favicon,
              chunks_per_source: 3,
            });
            return {
              content: [{
                type: "text",
                text: formatCrawlResults(crawlResponse)
              }]
            };
          }

          case "deepseek_map": {
            const args = rawArgs;
            const mapResponse = await this.map({
              url: args.url,
              max_depth: args.max_depth,
              max_breadth: args.max_breadth,
              limit: args.limit,
              instructions: args.instructions,
              select_paths: Array.isArray(args.select_paths) ? args.select_paths : [],
              select_domains: Array.isArray(args.select_domains) ? args.select_domains : [],
              allow_external: args.allow_external
            });
            return {
              content: [{
                type: "text",
                text: formatMapResults(mapResponse)
              }]
            };
          }

          case "deepseek_research": {
            if (typeof rawArgs.input !== 'string' || !rawArgs.input.trim()) {
              return {
                content: [{ type: "text", text: toolError('ValidationError', 'input 必须为非空字符串') }],
                isError: true,
              };
            }
            const researchRun = await runResearch({
              task: rawArgs.input,
              config: researchConfig,
              searchFn: (params: any) => this.search(params),
            });
            if (researchRun.error) {
              return {
                content: [{ type: "text", text: toolError('ResearchError', researchRun.error) }],
                isError: true,
              };
            }
            return {
              content: [{
                type: "text",
                text: `${researchRun.report}\n\n${researchRun.annotation}`,
              }],
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }

        const text = formatResults(response);
        // ② extract 全失败（无 results + 有 failed_results）→ isError
        if (request.params.name === 'deepseek_extract' && isExtractTotalFailure(response)) {
          return {
            content: [{ type: "text", text }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text }]
        };
      } catch (error: any) {
        // ⑥ 剥 category 后 query 为空等校验失败
        if (error?.name === 'ValidationError') {
          return {
            content: [{ type: "text", text: toolError('ValidationError', String(error.message ?? error)) }],
            isError: true,
          };
        }
        if (axios.isAxiosError(error)) {
          if (isKeylessEnvelope(error.response?.data)) {
            return {
              content: [{
                type: "text",
                text: formatKeylessEnvelope(error.response!.data)
              }]
            };
          }
          const toolName = request.params.name?.replace('deepseek_', '') || '';
          const docsUrl = this.docsURLs[toolName] || '';
          const responseData = error.response?.data;
          const detail = responseData && typeof responseData === 'object'
            ? (responseData.detail || responseData.message || responseData)
            : (error.message);
          const detailStr = redactSensitive(typeof detail === 'object' ? JSON.stringify(detail) : String(detail));
          const docsSuffix = docsUrl ? `\nDocumentation: ${docsUrl}` : '';
          return {
            content: [{
              type: "text",
              text: toolError('TavilyAPIError', `${detailStr}${docsSuffix}`)
            }],
            isError: true,
          }
        }
        // Everything else follows the error-prefix convention too.
        if (error instanceof SearchProviderFailure) {
          if (error.data && isKeylessEnvelope(error.data)) {
            return {
              content: [{ type: "text", text: formatKeylessEnvelope(error.data) }],
            };
          }
          return {
            content: [{ type: "text", text: toolError(error.name, error.message) }],
            isError: true,
          };
        }
        if (error instanceof McpError) {
          throw new McpError(
            error.code,
            toolError(error.name ?? 'Error', error.message)
          );
        }
        const type = error?.name ?? 'Error';
        const message = error?.message ? String(error.message) : String(error);
        throw new McpError(ErrorCode.InternalError, toolError(type, message));
      }
    });
  }


  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log('info', 'deepseek-websearch MCP server running on stdio');
  }

  async search(params: any): Promise<TavilyResponse> {
      const defaults = this.getDefaultParameters();

      // Prepare the request payload (official logic preserved)
      let searchParams: any = {
        query: params.query,
        search_depth: params.search_depth,
        topic: params.topic,
        time_range: params.time_range,
        max_results: params.max_results,
        chunks_per_source: params.chunks_per_source,
        include_answer: params.include_answer,
        include_images: params.include_images,
        include_image_descriptions: params.include_image_descriptions,
        include_raw_content: params.include_raw_content,
        include_domains: params.include_domains || [],
        exclude_domains: params.exclude_domains || [],
        country: params.country,
        include_favicon: params.include_favicon,
        start_date: params.start_date,
        end_date: params.end_date,
        exact_match: params.exact_match,
      };
      // api_key 不再写死全局（多 key 方案 §6 步骤 4）：在 searchWithKeyPool 内按所选 key 注入。

      // DEFAULT_PARAMETERS 只填用户未传的字段，不覆盖显式参数
      for (const key in defaults) {
        if (searchParams[key] === undefined) {
          searchParams[key] = defaults[key];
        }
      }

      // 最优解默认：answer=basic、chunks=2（显式 / DEFAULT_PARAMETERS 已设则保留）
      searchParams = applySearchDefaults(searchParams);

      // We have to set defaults due to the issue with optional parameter types or defaults = None
      // Because of this, we have to set the time_range to None if start_date or end_date is set
      // or else start_date and end_date will always cause errors when sent
      if ((searchParams.start_date || searchParams.end_date) && searchParams.time_range) {
        searchParams.time_range = undefined;
      }

      // Remove empty values
      const cleanedParams: any = {};
      for (const key in searchParams) {
        const value = searchParams[key];
        // Skip empty strings, null, undefined, and empty arrays
        // include_answer: false 必须保留（否则又被 apply 成 basic）
        if (value !== "" && value !== null && value !== undefined &&
            !(Array.isArray(value) && value.length === 0)) {
          cleanedParams[key] = value;
        }
      }
      // false 被上面跳过了——显式关闭 answer 时不要发给 API（等同 omit）
      // 若需「无 answer」：omit 即可；cleaned 不含 false 正确。

      // ①⑥ 统一剥 category:（进池前）；空 query → ValidationError，不回落原串
      const parsed = parseExaCategory(String(cleanedParams.query ?? ''));
      if (parsed.category !== undefined && !parsed.query) {
        const err = new Error('query 在剥离 category: 后为空');
        err.name = 'ValidationError';
        throw err;
      }
      cleanedParams.query = parsed.query;
      if (parsed.category) cleanedParams.category = parsed.category;

      // ⑤ max_results 钳 1–20
      if (typeof cleanedParams.max_results === 'number') {
        cleanedParams.max_results = clampMaxResults(cleanedParams.max_results);
      }

      return this.searchWithKeyPool(cleanedParams);
  }

  /** Tavily 请求头：有 key → Authorization Bearer；无 key（keyless）→ keyless access mode。 */
  private tavilyHeaders(key?: string): Record<string, string> {
    return key
      ? { 'Authorization': `Bearer ${key}`, 'X-Client-Source': 'MCP' }
      : { 'X-Tavily-Access-Mode': 'keyless', 'X-Client-Source': 'deepseek-websearch-keyless' };
  }

  /** Tavily 池选 key 并重试：选中的 key 失败 → 试下一 key（全 kind 换 key）；全失败聚合抛错。 */
  private async withTavilyKey<T>(run: (key: string | undefined) => Promise<T>): Promise<T> {
    if (TAVILY_CANDIDATES.length === 0) {
      return run(undefined); // keyless
    }
    try {
      const { value } = await retryOverPool<T>(tavilyPool, (cand) => run(cand.key));
      return value;
    } catch (err) {
      throw new SearchProviderFailure(
        err instanceof Error ? err.message : String(err),
        null,
        'error'
      );
    }
  }

  // 多 key 加权轮询（方案 §5）：按权重选引擎+key，单次请求内失败试完池中每个 key 一次。
  // 全池空 → 现网 keyless 行为（Tavily keyless）。总墙钟 SEARCH_FAILOVER_TOTAL_TIMEOUT_MS。
  private async searchWithKeyPool(payload: any): Promise<TavilyResponse> {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), SEARCH_FAILOVER_TOTAL_TIMEOUT_MS);

    try {
      // Tavily 不认 category（仅 Exa）；请求体剥掉，避免字面泄漏
      const tavilyBody = (() => {
        const { category: _cat, ...rest } = payload;
        return rest;
      })();

      // ---- 无任何池：现网 keyless 行为（Tavily keyless，不建池）----
      if (SEARCH_CANDIDATES.length === 0) {
        try {
          const response = await retryTransientHttp(() =>
            this.axiosInstance.post(this.baseURLs.search, tavilyBody, {
              headers: this.tavilyHeaders(undefined),
              timeout: SEARCH_PROVIDER_TIMEOUT_MS,
              signal: controller.signal,
            })
          );
          raiseForStatus('Tavily', response.status, bodyText(response.data));
          validateSearchPayload(response.data, 'Tavily');
          const data: TavilyResponse = response.data;
          data._provider = 'tavily';
          return data;
        } catch (err) {
          throw toProviderFailure('Tavily', err, 'tavily');
        }
      }

      // ---- 池化：WRR 选起始 key，失败按权重顺序换下一 key（§5.3 每 key 一次）----
      let picked: { provider: 'tavily' | 'exa'; data: TavilyResponse } | null = null;
      let attempts: string[] = [];
      try {
        ({ value: picked, attempts } = await retryOverPool<{ provider: 'tavily' | 'exa'; data: TavilyResponse }>(
          searchPool,
          async (cand) => {
            const providerLabel = cand.provider === 'tavily' ? 'Tavily' : 'Exa';
            try {
              if (cand.provider === 'tavily') {
                const response = await retryTransientHttp(() =>
                  this.axiosInstance.post(this.baseURLs.search, {
                    ...tavilyBody,
                    api_key: cand.key,
                  }, {
                    headers: this.tavilyHeaders(cand.key),
                    timeout: SEARCH_PROVIDER_TIMEOUT_MS,
                    signal: controller.signal,
                  })
                );
                raiseForStatus('Tavily', response.status, bodyText(response.data));
                validateSearchPayload(response.data, 'Tavily');
                return { provider: 'tavily' as const, data: response.data };
              }
              const response = await retryTransientHttp(() =>
                axios.post(
                  'https://api.exa.ai/search',
                  buildExaPayload(payload),
                  {
                    headers: {
                      'x-api-key': cand.key,
                      'Content-Type': 'application/json',
                      'Accept': 'application/json',
                    },
                    timeout: SEARCH_PROVIDER_TIMEOUT_MS,
                    signal: controller.signal,
                  }
                )
              );
              raiseForStatus('Exa', response.status, bodyText(response.data));
              validateSearchPayload(response.data, 'Exa');
              return { provider: 'exa' as const, data: mapExaResultsToTavily(response.data) };
            } catch (err) {
              // axios 4xx/超时/网络必须走分类，否则丢失 kind 与「卡在 tavily/exa」标注
              throw toProviderFailure(providerLabel, err, cand.provider);
            }
          }
        ));
      } catch (err) {
        throw new SearchProviderFailure(
          err instanceof Error ? err.message : String(err),
          null, 'error'
        );
      }

      // 重试成功（非首 key）→ 标注实际 provider 与失败原因（已脱敏）
      if (picked && attempts.length > 0) {
        picked.data.answer = `[retried on ${picked.provider} after: ${attempts[0].slice(0, 160)}]`;
      }
      // ③ 挂内部 _provider，供 formatResults 输出（不进 answer）
      picked!.data._provider = picked!.provider;
      return picked!.data;
    } finally {
      clearTimeout(totalTimer);
    }
  }

  async extract(params: any): Promise<TavilyResponse> {
    return this.withTavilyKey(async (key) => {
      const response = await this.axiosInstance.post(this.baseURLs.extract, {
        ...params,
        ...(key ? { api_key: key } : {}),
      }, {
        headers: this.tavilyHeaders(key),
        timeout: EXTRACT_TIMEOUT_MS,
      });
      return response.data;
    });
  }

  async crawl(params: any): Promise<TavilyCrawlResponse> {
    const controller = new AbortController();
    const crawlDeadline = Date.now() + CRAWL_TOTAL_TIMEOUT_MS;
    const totalTimer = setTimeout(() => controller.abort(), CRAWL_TOTAL_TIMEOUT_MS);
    let crawlPhase: '建任务' | '轮询' = '建任务';

    try {
      // ---- Submit the crawl job (Tavily /crawl is async: returns job_id) ----
      // Tavily 池选 key + 失败换下一 key；submit 成功返回 { data, key }，poll 沿用同一 key。
      const { data, key } = await this.withTavilyKey(async (k) => {
        const response = await this.axiosInstance.post(this.baseURLs.crawl, {
          ...params,
          ...(k ? { api_key: k } : {}),
        }, {
          headers: this.tavilyHeaders(k),
          timeout: CRAWL_SUBMIT_TIMEOUT_MS,
          signal: controller.signal,
        });
        return { data: response.data, key: k };
      });

      // Dual-mode: synchronous-style responses (already contain results) are
      // returned as-is; otherwise treat the response as a job handle.
      if (data && typeof data === 'object' && Array.isArray(data.results)) {
        return data as TavilyCrawlResponse;
      }

      const jobId = data?.job_id ?? data?.id ?? data?.crawl_id;
      if (!jobId) {
        throw new SearchProviderFailure(
          `deepseek_crawl: no job_id in submit response: ${bodyText(data).slice(0, 300)}`,
          null, 'error'
        );
      }
      crawlPhase = '轮询';

      // ---- Poll until completed / failed（墙钟预算含 sleep + 每次 poll 请求；与 crawlDeadline 对齐）----
      let pollInterval = CRAWL_POLL_INTERVAL_MS;
      while (Date.now() < crawlDeadline) {
        const wait = Math.min(pollInterval, crawlDeadline - Date.now());
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        if (Date.now() >= crawlDeadline) break;

        let pollResponse;
        try {
          pollResponse = await this.axiosInstance.get(
            `${this.baseURLs.crawl}/${jobId}`,
            { headers: this.tavilyHeaders(key), timeout: CRAWL_SUBMIT_TIMEOUT_MS, signal: controller.signal }
          );
        } catch (pollErr: any) {
          if (pollErr.response?.status && pollErr.response.status >= 500) {
            continue; // 瞬时 5xx：退避后重试（墙钟预算自然约束，P2-9）
          }
          throw pollErr;
        }
        const pollData = pollResponse.data;
        const status = pollData?.status;

        if (status === 'completed') {
          const results = Array.isArray(pollData.results) ? pollData.results : [];
          return {
            base_url: String(pollData.base_url ?? params.url ?? ''),
            results,
            response_time: typeof pollData.response_time === 'number' ? pollData.response_time : 0,
          } as TavilyCrawlResponse;
        }
        if (status === 'failed' || status === 'error') {
          throw new SearchProviderFailure(
            `deepseek_crawl: job failed（卡在 crawl 轮询）: ${bodyText(pollData).slice(0, 300)}`,
            pollResponse.status, 'error'
          );
        }

        pollInterval = Math.min(pollInterval * CRAWL_POLL_BACKOFF_FACTOR, CRAWL_MAX_POLL_INTERVAL_MS);
      }

      throw new SearchProviderFailure(
        `deepseek_crawl: job timed out after ${CRAWL_TOTAL_TIMEOUT_MS / 1000}s（卡在 crawl 轮询）`,
        null, 'error'
      );
    } catch (err: any) {
      if (err instanceof SearchProviderFailure) throw err;
      if (err?.code === 'ERR_CANCELED' || axios.isCancel(err)) {
        throw new SearchProviderFailure(
          `deepseek_crawl: timed out after ${CRAWL_TOTAL_TIMEOUT_MS / 1000}s（卡在 crawl ${crawlPhase}）`,
          null, 'error'
        );
      }
      if (err?.code === 'ECONNABORTED') {
        throw new SearchProviderFailure(
          `deepseek_crawl: request timed out（卡在 crawl ${crawlPhase}）`,
          null, 'error'
        );
      }
      throw err;
    } finally {
      clearTimeout(totalTimer);
    }
  }

  async map(params: any): Promise<TavilyMapResponse> {
    return this.withTavilyKey(async (key) => {
      const response = await this.axiosInstance.post(this.baseURLs.map, {
        ...params,
        ...(key ? { api_key: key } : {}),
      }, {
        headers: this.tavilyHeaders(key),
        timeout: MAP_TIMEOUT_MS,
      });
      return response.data;
    });
  }

  /** Read at most maxBytes from a stream as text, then destroy it. */
  private readStreamBounded(stream: any, maxBytes: number): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      const timer = setTimeout(() => { stream.destroy(); resolve(data); }, 10000);
      const finish = () => { clearTimeout(timer); resolve(data); };
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf-8');
        if (data.length >= maxBytes) stream.destroy();
      });
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', finish);
    });
  }
}

function isKeylessEnvelope(data: any): boolean {
  // Recognises the Tavily API's recoverable-error envelope shape.
  // Used for keyless rate-limit caps and endpoints that require an API key.
  return !!(data && typeof data === 'object'
    && data.error && typeof data.error === 'object'
    && typeof data.error.code === 'string');
}

function formatKeylessEnvelope(data: any): string {
  const err = data.error;
  const lines: string[] = [String(err.message ?? '')];
  if (err.retry_after_seconds != null) {
    lines.push(`Retry after: ${err.retry_after_seconds}s`);
  }
  if (Array.isArray(err.next_actions)) {
    for (const a of err.next_actions) {
      if (a?.type === 'agentic_payment') {
        const detail = a.details ? ` ${a.details}` : '';
        lines.push(`agentic_payment scheme=${a.scheme ?? 'x402'}${detail}`);
      } else if (a?.type === 'signup') {
        const url = a.url ? ` ${a.url}` : '';
        lines.push(`TAVILY_API_KEY required${url}`);
      } else if (a?.type === 'bonus_credits' && a.eligible) {
        lines.push(`bonus_credits endpoint=${a.endpoint ?? ''}`);
      }
    }
  }
  return lines.filter(Boolean).join('\n');
}

export function formatResults(response: TavilyResponse): string {
  // Format API response into human-readable text
  const output: string[] = [];

  // ③ Provider 独立一行（不进 answer，避免与 Tavily Answer 糊在一起）
  if (response._provider === 'tavily' || response._provider === 'exa') {
    output.push(`Provider: ${response._provider}`);
  }

  // Include answer if available
  if (response.answer) {
    output.push(`Answer: ${response.answer}`);
  }

  // Format detailed search results (full content; no ID/Favicon)
  output.push('Detailed Results:');
  const results = Array.isArray(response.results) ? response.results : [];
  results.forEach(result => {
    if (!result || typeof result !== 'object') return; // skip null / 非对象混合条目
    output.push(`\nTitle: ${result.title ?? ''}`);
    output.push(`URL: ${result.url ?? ''}`);
    const contentText = result.content ?? result.raw_content ?? '';
    output.push(`Content: ${contentText}`);
    if (result.raw_content && result.raw_content !== contentText) {
      output.push(`Raw Content: ${result.raw_content}`);
    }
  });

  // Add images section if available
  if (response.images && response.images.length > 0) {
    output.push('\nImages:');
    response.images.forEach((image, index) => {
      if (typeof image === 'string') {
        output.push(`\n[${index + 1}] URL: ${image}`);
      } else {
        output.push(`\n[${index + 1}] URL: ${image.url ?? ''}`);
        if (image.description) {
          output.push(`   Description: ${image.description}`);
        }
      }
    });
  }

  // extract 部分 URL 失败：成功页照常输出，失败列表单独可读（Exa 借鉴方案 §2 C）
  const failed = Array.isArray(response.failed_results) ? response.failed_results : [];
  if (failed.length > 0) {
    output.push('\nFailed URLs:');
    failed.forEach((item, index) => {
      if (typeof item === 'string') {
        output.push(`[${index + 1}] ${item}`);
        return;
      }
      if (!item || typeof item !== 'object') return;
      const url = item.url ?? '';
      const err = item.error ?? 'unknown error';
      output.push(`[${index + 1}] ${url}: ${err}`);
    });
  }

  return output.join('\n');
}

export function formatCrawlResults(response: TavilyCrawlResponse): string {
  const output: string[] = [];
  
  output.push(`Crawl Results:`);
  output.push(`Base URL: ${response.base_url ?? ''}`);
  
  // crawl 多页全量会爆 token：仅此路径保留 preview（search/extract 不截断）
  const CRAWL_PREVIEW_CHARS = 800;
  let previewedAny = false;
  output.push('\nCrawled Pages:');
  const crawlPages = Array.isArray(response.results) ? response.results : [];
  crawlPages.forEach((page, index) => {
    if (!page || typeof page !== 'object') return;
    output.push(`\n[${index + 1}] URL: ${page.url ?? ''}`);
    if (page.raw_content) {
      const raw = page.raw_content;
      const previewed = raw.length > CRAWL_PREVIEW_CHARS;
      if (previewed) previewedAny = true;
      const contentPreview = previewed
        ? raw.substring(0, CRAWL_PREVIEW_CHARS) + '…'
        : raw;
      output.push(`Content (preview): ${contentPreview}`);
    }
  });
  if (previewedAny) {
    output.push(
      '\n[Crawl pages are preview-only; use deepseek_extract on a specific URL for full text]'
    );
  }

  return output.join('\n');
}

export function formatMapResults(response: TavilyMapResponse): string {
  const output: string[] = [];

  output.push(`Site Map Results:`);
  output.push(`Base URL: ${response.base_url ?? ''}`);

  output.push('\nMapped Pages:');
  const mapPages = Array.isArray(response.results) ? response.results : [];
  mapPages.forEach((page, index) => {
    if (page == null || page === '') return;
    output.push(`\n[${index + 1}] URL: ${page ?? ''}`);
  });

  return output.join('\n');
}


function listTools(): void {
  const tools = [
    {
      name: "deepseek_search",
      description: "Live web search. query required. search_depth basic(1 credit,default)|advanced(2). For URLs use deepseek_extract; deep report use deepseek_research."
    },
    {
      name: "deepseek_extract",
      description: "Extract page content from URLs. After search when snippets thin."
    },
    {
      name: "deepseek_crawl",
      description: "Crawl site for page content (async, ~5 min wall). URL list only → deepseek_map."
    },
    {
      name: "deepseek_map",
      description: "List site URLs from base URL. Content → deepseek_crawl or deepseek_extract."
    },
    {
      name: "deepseek_research",
      description: "Multi-step research report (capped cost). Quick fact → deepseek_search."
    }
  ];

  console.log("Available tools:");
  tools.forEach(tool => {
    console.log(`\n- ${tool.name}`);
    console.log(`  Description: ${tool.description}`);
  });
  process.exit(0);
}

// Add this interface before the command line parsing
interface Arguments {
  'list-tools': boolean;
  _: (string | number)[];
  $0: string;
}

// Modify the command line parsing section to use proper typing
const argv = yargs(hideBin(process.argv))
  .option('list-tools', {
    type: 'boolean',
    description: 'List all available tools and exit',
    default: false
  })
  .help()
  .parse() as Arguments;

// Otherwise start the server. The direct-run guard lets tests import this
// module (and its pure helpers) without starting a server.
const isDirectRun = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (argv['list-tools']) {
  listTools();
}

if (isDirectRun) {
  const server = new TavilyClient();
  server.run().catch((error: any) => {
    log('error', `Fatal: ${error?.message ?? error}`);
    process.exit(1);
  });
}