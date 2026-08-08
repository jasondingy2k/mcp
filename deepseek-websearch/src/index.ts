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
import { loadEnvFile, makeLogger, makeToolError, redactSensitive } from 'mcp-common';
import { readResearchConfig, runResearch } from './research.js';
export * from './research.js';
export { redactSensitive };

// .env 约定：启动时只加载一次（mcp-common 单一实现）。
loadEnvFile();

const API_KEY = process.env.TAVILY_API_KEY;
const IS_KEYLESS = !API_KEY;
const HUMAN_ID = process.env.TAVILY_HUMAN_ID;
const SESSION_ID = randomUUID();

// ---- 静默日志 + 错误前缀（工作区约定，mcp-common 单一实现）----
const log = makeLogger('deepseek-websearch', 'DEEPSEEK_WEBSEARCH_LOG_LEVEL');
export const toolError = makeToolError('deepseek-websearch');

// ---- Tavily→Exa search failover (workspace convention, ported from
// agent-websearch providers.py search_with_failover) ----
const EXA_API_KEY = process.env.EXA_API_KEY || process.env.EXASEARCH_API_KEY;
const SEARCH_PROVIDER_TIMEOUT_MS = 30000;       // per-provider HTTP budget
const SEARCH_FAILOVER_TOTAL_TIMEOUT_MS = 60000; // total Tavily→Exa sequence budget
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
// 401/403 → auth; 402/429 → quota/rate. Only `error` may soft-fallback to Exa
// (auth/quota/rate never fallback — see shouldFallbackToExa).
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

/** Exa fallback only for non-auth, non-quota, non-rate failures (5xx/timeout/malformed). */
export function shouldFallbackToExa(kind: SearchFailureKind): boolean {
  return kind === 'error';
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

// Map the search params that Exa understands; the rest are ignored.
export function buildExaPayload(params: any): Record<string, any> {
  const payload: Record<string, any> = {
    query: params.query,
    numResults: typeof params.max_results === 'number' ? params.max_results : 5,
    type: 'auto',
    contents: { text: { maxCharacters: 1200 } },
  };
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

// Map an Exa payload onto the TavilyResponse shape so the existing
// formatResults() renders it unchanged.
export function mapExaResultsToTavily(data: any): TavilyResponse {
  const raw = Array.isArray(data.results) ? data.results : [];
  const results = raw
    .filter((item: any) => item && typeof item === 'object')
    .map((item: any) => {
      let contents: string = item.text || item.summary || '';
      if (Array.isArray(item.highlights)) {
        contents = item.highlights.join(' [...] ');
      }
      return {
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        content: String(contents ?? ''),
        score: typeof item.score === 'number' ? item.score : 0,
        id: item.id ? String(item.id) : '',
      };
    });
  return { query: String(data.query ?? ''), results };
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

    this.axiosInstance = axios.create({
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        ...(IS_KEYLESS
          ? { 'X-Tavily-Access-Mode': 'keyless', 'X-Client-Source': 'deepseek-websearch-keyless' }
          : { 'Authorization': `Bearer ${API_KEY}`, 'X-Client-Source': 'MCP' }),
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
          description: "MUST use for live/time-sensitive web info. For specific URLs use deepseek_extract; for deep reports use deepseek_research.",
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
                description: "basic / advanced / fast / ultra-fast",
                default: "basic"
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
                description: "Boost country by full name (e.g. 'Japan'; ISO codes like 'us' not supported)"
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
          description: "Extract full page content from user-provided URLs. Do NOT use deepseek_search for URL extraction.",
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
              }
            },
            required: ["urls"]
          }
        },
        {
          name: "deepseek_crawl",
          description: "Crawl a site for page content (async, ~5 min). For URL list only, use deepseek_map.",
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
          description: "List a site's URLs from a base URL. For page content use deepseek_crawl or deepseek_extract.",
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
          description: "Depth research report（主代理先广后深：5–10 次 basic search + 综合报告，成本封顶 10 点）。For a quick query use deepseek_search.",
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
        const args = request.params.arguments ?? {};

        switch (request.params.name) {
          case "deepseek_search":
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
          
          case "deepseek_extract":
            response = await this.extract({
              urls: args.urls,
              extract_depth: args.extract_depth,
              include_images: args.include_images,
              format: args.format,
              include_favicon: args.include_favicon,
              query: args.query,
            });
            break;

          case "deepseek_crawl":
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

          case "deepseek_map":
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

          case "deepseek_research": {
            if (typeof args.input !== 'string' || !args.input.trim()) {
              return {
                content: [{ type: "text", text: toolError('ValidationError', 'input 必须为非空字符串') }],
                isError: true,
              };
            }
            const researchRun = await runResearch({
              task: args.input,
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

        return {
          content: [{
            type: "text",
            text: formatResults(response)
          }]
        };
      } catch (error: any) {
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
      const searchParams: any = {
        query: params.query,
        search_depth: params.search_depth,
        topic: params.topic,
        time_range: params.time_range,
        max_results: params.max_results,
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
        ...(IS_KEYLESS ? {} : { api_key: API_KEY }),
      };
      
      // DEFAULT_PARAMETERS 只填用户未传的字段，不覆盖显式参数
      for (const key in defaults) {
        if (searchParams[key] === undefined) {
          searchParams[key] = defaults[key];
        }
      }
      
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
        if (value !== "" && value !== null && value !== undefined && 
            !(Array.isArray(value) && value.length === 0)) {
          cleanedParams[key] = value;
        }
      }
      
      return this.searchWithFailover(cleanedParams);
  }

  // Tavily first; Exa only on kind=error（5xx/超时/畸形）. auth/quota/rate 不切换。
  // Total budget SEARCH_FAILOVER_TOTAL_TIMEOUT_MS；超时标注（卡在 tavily / exa）.
  private async searchWithFailover(payload: any): Promise<TavilyResponse> {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), SEARCH_FAILOVER_TOTAL_TIMEOUT_MS);
    const errors: string[] = [];
    let tavilyHttp: number | null = null;
    let fallbackReason: SearchFailureKind | null = null;
    let phase: 'tavily' | 'exa' | null = null;

    try {
      // ---- Tavily (primary) ----
      phase = 'tavily';
      try {
        const response = await this.axiosInstance.post(this.baseURLs.search, payload, {
          timeout: SEARCH_PROVIDER_TIMEOUT_MS,
          signal: controller.signal,
        });
        raiseForStatus('Tavily', response.status, bodyText(response.data));
        validateSearchPayload(response.data, 'Tavily');
        return response.data;
      } catch (err: any) {
        const failure = toProviderFailure('Tavily', err, phase);
        tavilyHttp = failure.http;
        if (!shouldFallbackToExa(failure.kind)) {
          throw failure; // auth / quota / rate: never soft-fallback to Exa
        }
        errors.push(failure.message);
        fallbackReason = failure.kind;
      }

      // ---- Exa (fallback) ----
      if (EXA_API_KEY) {
        phase = 'exa';
        try {
          const response = await axios.post(
            'https://api.exa.ai/search',
            buildExaPayload(payload),
            {
              headers: {
                'x-api-key': EXA_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              timeout: SEARCH_PROVIDER_TIMEOUT_MS,
              signal: controller.signal,
            }
          );
          raiseForStatus('Exa', response.status, bodyText(response.data));
          validateSearchPayload(response.data, 'Exa');
          const result = mapExaResultsToTavily(response.data);
          // 优先给完整失败详情（errors[0] 已脱敏），fallbackReason 只是 kind 无信息量
          result.answer = `[fallback: used Exa after Tavily issue: ${(errors[0] ?? fallbackReason ?? 'error').slice(0, 160)}]`;
          return result;
        } catch (err: any) {
          errors.push(toProviderFailure('Exa', err, phase).message);
          throw new SearchProviderFailure(
            `All providers failed:\n- ${errors.join('\n- ')}`,
            tavilyHttp,
            'error'
          );
        }
      }

      throw new SearchProviderFailure(
        `No working search provider. Set TAVILY_API_KEY and/or EXA_API_KEY.\n${errors.join('\n')}`,
        tavilyHttp,
        fallbackReason ?? 'error'
      );
    } finally {
      clearTimeout(totalTimer);
    }
  }

  async extract(params: any): Promise<TavilyResponse> {
    const response = await this.axiosInstance.post(this.baseURLs.extract, {
      ...params,
      ...(IS_KEYLESS ? {} : { api_key: API_KEY })
    }, {
      timeout: EXTRACT_TIMEOUT_MS,
    });
    return response.data;
  }

  async crawl(params: any): Promise<TavilyCrawlResponse> {
    const controller = new AbortController();
    const crawlDeadline = Date.now() + CRAWL_TOTAL_TIMEOUT_MS;
    const totalTimer = setTimeout(() => controller.abort(), CRAWL_TOTAL_TIMEOUT_MS);
    let crawlPhase: '建任务' | '轮询' = '建任务';

    try {
      // ---- Submit the crawl job (Tavily /crawl is async: returns job_id) ----
      const response = await this.axiosInstance.post(this.baseURLs.crawl, {
        ...params,
        ...(IS_KEYLESS ? {} : { api_key: API_KEY })
      }, {
        timeout: CRAWL_SUBMIT_TIMEOUT_MS,
        signal: controller.signal,
      });

      const data = response.data;

      // Dual-mode: synchronous-style responses (already contain results) are
      // returned as-is; otherwise treat the response as a job handle.
      if (data && typeof data === 'object' && Array.isArray(data.results)) {
        return data as TavilyCrawlResponse;
      }

      const jobId = data?.job_id ?? data?.id ?? data?.crawl_id;
      if (!jobId) {
        throw new SearchProviderFailure(
          `deepseek_crawl: no job_id in submit response: ${bodyText(data).slice(0, 300)}`,
          response.status, 'error'
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
            { timeout: CRAWL_SUBMIT_TIMEOUT_MS, signal: controller.signal }
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
    const response = await this.axiosInstance.post(this.baseURLs.map, {
      ...params,
      ...(IS_KEYLESS ? {} : { api_key: API_KEY })
    }, {
      timeout: MAP_TIMEOUT_MS,
    });
    return response.data;
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
  // Render the Tavily API's recoverable-error envelope as plain text:
  // the natural-language message, followed by retry-after (when present).
  const err = data.error;
  const lines: string[] = [String(err.message ?? '')];
  if (err.retry_after_seconds != null) {
    lines.push(`Retry after: ${err.retry_after_seconds}s`);
  }
  if (Array.isArray(err.next_actions) && err.next_actions.length > 0) {
    lines.push('', 'Continuation options:');
    for (const a of err.next_actions) {
      if (a?.type === 'agentic_payment') {
        lines.push(`- Agentic payment (${a.scheme ?? 'x402'}): ${a.details ?? ''}`);
      } else if (a?.type === 'signup') {
        lines.push(`- Sign up for a Tavily API key: ${a.url ?? ''}`);
      } else if (a?.type === 'bonus_credits' && a.eligible) {
        lines.push(`- Earn ${a.credits_on_completion ?? ''} bonus credits by POSTing answers to ${a.endpoint ?? ''}`);
        if (Array.isArray(a.questions)) {
          a.questions.forEach((q: string, i: number) => lines.push(`    ${i + 1}. ${q}`));
        }
      }
    }
  }
  return lines.filter(Boolean).join('\n');
}

export function formatResults(response: TavilyResponse): string {
  // Format API response into human-readable text
  const output: string[] = [];

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
      description: "MUST use for live/time-sensitive web info. For specific URLs use deepseek_extract; for deep reports use deepseek_research."
    },
    {
      name: "deepseek_extract",
      description: "Extract full page content from user-provided URLs. Do NOT use deepseek_search for URL extraction."
    },
    {
      name: "deepseek_crawl",
      description: "Crawl a site for page content (async, ~5 min). For URL list only, use deepseek_map."
    },
    {
      name: "deepseek_map",
      description: "List a site's URLs from a base URL. For page content use deepseek_crawl or deepseek_extract."
    },
    {
      name: "deepseek_research",
      description: "Depth research report（主代理先广后深：5–10 次 basic search + 综合报告，成本封顶 10 点）。For a quick query use deepseek_search."
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