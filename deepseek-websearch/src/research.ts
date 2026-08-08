// research.ts — research 主代理（改造方案 2026-08-08）。
// 阶段 3：广度规划（LLM#1）+ 并行执行（evidence 双轨）+ 深度规划（LLM#2）+ 串行渐进执行。
// 综合报告在阶段 4。零运行生成物：全程内存传递，不落盘、不缓存。日志由 index.ts 的 log 处理。
// LLM 调用用 node 20+ 内置 fetch + AbortController，零新增依赖。
import { redactSensitive } from 'mcp-common';

// ---- 配置类型与读取（方案 §5）----
export interface ResearchConfig {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  minSearches: number;
  maxSearches: number;
  minBreadth: number;
  minDepth: number;
  totalTimeoutMs: number;
}

export const RESEARCH_DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const RESEARCH_DEFAULT_MODEL = 'deepseek-v4-flash';
export const RESEARCH_DEFAULT_MIN_SEARCHES = 5;
export const RESEARCH_DEFAULT_MAX_SEARCHES = 10;
export const RESEARCH_DEFAULT_MIN_BREADTH = 3;
export const RESEARCH_DEFAULT_MIN_DEPTH = 2;
export const RESEARCH_TOTAL_TIMEOUT_MS = 480000;        // 总墙钟硬上限（方案 §6）
export const RESEARCH_PLAN_TIMEOUT_MS = 60000;          // 规划单次超时
export const RESEARCH_PLAN_MAX_ATTEMPTS = 2;            // 规划 JSON 解析失败重试 1 次
export const RESEARCH_SYNTHESIS_TIMEOUT_MS = 120000;    // 综合超时
export const RESEARCH_BREADTH_MAX_RESULTS = 4;          // 广度/深度子 search 默认 max_results（§6：3~5）
export const RESEARCH_DEPTH_BRIEF_HEAD_CHARS = 300;     // 深度规划每条 brief 只取 title+url+首段摘要，不喂全文（防输入挤崩输出）

/** 正整数解析；非法/空/负数回退 fallback（与 .env 约定一致，不抛错）。 */
export function parseResearchInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 读 research 主代理配置（与 deepseek-vision 独立，不读 OPENCODE_* / VISION_*）。
 * apiKey: 仅 RESEARCH_API_KEY；
 * baseUrl: RESEARCH_BASE_URL → 默认 opencode zen/go。
 * 一致性：min ≤ max；minBreadth + minDepth ≤ max（超出时收紧 minDepth，再兜 breadth）。
 */
export function readResearchConfig(
  env: Record<string, string | undefined> = process.env
): ResearchConfig {
  let min = parseResearchInt(env.RESEARCH_MIN_SEARCHES, RESEARCH_DEFAULT_MIN_SEARCHES);
  const max = parseResearchInt(env.RESEARCH_MAX_SEARCHES, RESEARCH_DEFAULT_MAX_SEARCHES);
  if (min > max) min = max; // 一致性钳制：min 不高于 max
  let minBreadth = parseResearchInt(env.RESEARCH_MIN_BREADTH, RESEARCH_DEFAULT_MIN_BREADTH);
  let minDepth = parseResearchInt(env.RESEARCH_MIN_DEPTH, RESEARCH_DEFAULT_MIN_DEPTH);
  if (minBreadth + minDepth > max) minDepth = Math.max(1, max - minBreadth);
  if (minBreadth + minDepth > max) minBreadth = Math.max(1, max - minDepth);
  const baseUrl = (env.RESEARCH_BASE_URL || RESEARCH_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    apiKey: env.RESEARCH_API_KEY || undefined,
    baseUrl,
    model: env.RESEARCH_MODEL || RESEARCH_DEFAULT_MODEL,
    minSearches: min,
    maxSearches: max,
    minBreadth,
    minDepth,
    totalTimeoutMs: RESEARCH_TOTAL_TIMEOUT_MS,
  };
}

// ---- LLM 调用（原生 fetch，OpenAI 兼容端点）----
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatOpts {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  timeoutMs: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  finishReason: string | null; // 'stop' | 'length' | 其他；null 表示缺失
  usage: ChatUsage | null; // OpenAI 兼容 usage（诊断总窗余量；上游未返回则 null）
}

/** 单次 chat completion；重试由调用方控制（不内置重试）。错误体脱敏（mcp-common redactSensitive）。 */
export async function chatCompletion(opts: ChatOpts): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`research LLM HTTP ${res.status}: ${redactSensitive(body.slice(0, 200))}`);
    }
    const data: any = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content) {
      const finish = choice?.finish_reason ?? 'unknown';
      throw new Error(`research LLM: 空 content（finish_reason=${finish}）`);
    }
    const usage = data?.usage;
    return {
      content,
      finishReason: choice?.finish_reason ?? null,
      usage: usage && typeof usage.prompt_tokens === 'number'
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
            totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : 0,
          }
        : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 响应格式相关 400（response_format 不被端点支持）→ 触发去 json 降级。 */
function isResponseFormatError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  // 收紧：必须同时命中 response_format 与 HTTP 400，避免普通 400 误触发去 json 降级
  return /response_format/i.test(msg) && /HTTP 400/i.test(msg);
}

// ---- 规划 JSON（纯函数）----
export interface ResearchQuestion { question: string; reason: string; }
export interface BreadthPlan { intentSummary: string; breadth: ResearchQuestion[]; }
export interface DepthPlan { intentSummary: string; depth: ResearchQuestion[]; }

/** 剥 ```json / ```markdown / ``` … ``` markdown fence（400 降级或综合输出包裹时）。 */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```\w*\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1].trim() : trimmed;
}

/** 校验规划 JSON 形状（field 区分 breadth/depth）；非法返回 null（触发重试）。 */
function parseSubPlan(
  raw: string,
  field: 'breadth' | 'depth'
): { intentSummary: string; items: ResearchQuestion[] } | null {
  let obj: any;
  try { obj = JSON.parse(stripCodeFence(raw)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.intent_summary !== 'string' || !obj.intent_summary.trim()) return null;
  if (!Array.isArray(obj[field])) return null;
  const items: ResearchQuestion[] = [];
  for (const item of obj[field]) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.question !== 'string' || !item.question.trim()) return null;
    items.push({
      question: item.question.trim(),
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
    });
  }
  if (items.length === 0) return null;
  return { intentSummary: obj.intent_summary.trim(), items };
}

export function parseBreadthPlan(raw: string): BreadthPlan | null {
  const p = parseSubPlan(raw, 'breadth');
  return p ? { intentSummary: p.intentSummary, breadth: p.items } : null;
}

export function parseDepthPlan(raw: string): DepthPlan | null {
  const p = parseSubPlan(raw, 'depth');
  return p ? { intentSummary: p.intentSummary, depth: p.items } : null;
}

/** 数量钳制：上界截断；下界不补（允许更少，报告标注实际数，绝不补假问题）。 */
export function clampBreadth(plan: BreadthPlan, max: number): BreadthPlan {
  return plan.breadth.length > max
    ? { intentSummary: plan.intentSummary, breadth: plan.breadth.slice(0, max) }
    : plan;
}

// ---- 广度规划（LLM#1）----
export interface BuildBreadthPlanOpts {
  task: string;
  config: ResearchConfig;
  timeoutMs?: number;
  attempts?: number;
  chatFn?: (opts: ChatOpts) => Promise<ChatResult>;
}

export async function buildBreadthPlan(opts: BuildBreadthPlanOpts): Promise<BreadthPlan> {
  const chat = opts.chatFn ?? chatCompletion;
  const { config } = opts;
  if (!config.apiKey) {
    throw new Error('research: 未配置主代理 key（RESEARCH_API_KEY）（卡在 research 广度规划）');
  }
  const minBreadth = config.minBreadth;
  const maxBreadth = config.maxSearches - config.minDepth;
  const system = [
    'You are a research planner. Split the research task into orthogonal, self-contained search sub-questions.',
    'Rules:',
    `- Count y is in [${minBreadth}, ${maxBreadth}] (advisory; do not pad to the max).`,
    '- Write every question in English by default. Keep proper nouns, version numbers, and error codes exactly as in the user task. Each question must be a search-engine query, not an essay prompt.',
    '- Query craft: one intent per question; add year or "latest/recent" when timing matters; prefer phrasings that surface primary sources (official docs, papers, vendor/standards originals); avoid vague survey-style queries.',
    '- Sub-questions must be orthogonal—no near-duplicate paraphrases.',
    '- Each reason: one sentence on which part of the intent it serves. intent_summary: one or two sentences on goal, constraints, and non-goals.',
    'Output JSON only: {"intent_summary":"...","breadth":[{"question":"...","reason":"..."}]}',
  ].join('\n');
  const attempts = opts.attempts ?? RESEARCH_PLAN_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? RESEARCH_PLAN_TIMEOUT_MS;
  let lastErr: unknown = null;
  let useJson = true;
  for (let i = 0; i < attempts; i++) {
    try {
      const { content } = await chat({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Research task:\n${opts.task}` },
        ],
        json: useJson,
        maxTokens: 2000,
        timeoutMs,
      });
      const plan = parseBreadthPlan(content);
      if (!plan) { lastErr = new Error('广度规划 JSON 形状非法'); continue; }
      return clampBreadth(plan, maxBreadth);
    } catch (e) {
      lastErr = e;
      if (useJson && isResponseFormatError(e)) useJson = false; // 400 → 去 json 降级（重试）
    }
  }
  throw new Error(
    'research 广度规划失败（重试 ' + attempts + ' 次）（卡在 research 广度规划）: ' +
    (lastErr instanceof Error ? lastErr.message : String(lastErr))
  );
}

// ---- 广度执行 + brief/evidence 双轨 ----
export interface BriefResult { question: string; title: string; url: string; content: string; }
export interface EvidenceItem {
  question: string;
  phase: 'breadth' | 'depth';
  title: string;
  url: string;
  content: string;
  rawContent: string; // raw_content 全文（可能为空；Exa 回退无）
}
export interface FailedSearch { question: string; error: string; }
export interface BreadthOutcome { briefs: BriefResult[]; evidence: EvidenceItem[]; failed: FailedSearch[]; }

export interface RunBreadthOpts {
  plan: BreadthPlan;
  searchFn: (params: { query: string; max_results: number; search_depth: string; include_raw_content: boolean }) => Promise<any>;
  maxResults?: number;
}

/** 并行执行 y 路 search（basic），brief 给 LLM#2、evidence 给 LLM#3；部分失败不阻断（allSettled）。 */
export async function runBreadthSearches(opts: RunBreadthOpts): Promise<BreadthOutcome> {
  const maxResults = opts.maxResults ?? RESEARCH_BREADTH_MAX_RESULTS;
  const settled = await Promise.allSettled(
    opts.plan.breadth.map((q) =>
      opts.searchFn({ query: q.question, max_results: maxResults, search_depth: 'basic', include_raw_content: true })
    )
  );
  const briefs: BriefResult[] = [];
  const evidence: EvidenceItem[] = [];
  const failed: FailedSearch[] = [];
  settled.forEach((s, i) => {
    const question = opts.plan.breadth[i].question;
    if (s.status === 'rejected') {
      failed.push({ question, error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
      return;
    }
    const results = (s.value as any)?.results;
    if (!Array.isArray(results)) {
      failed.push({ question, error: 'search 响应无 results 数组' });
      return;
    }
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      const title = String(r.title ?? '');
      const url = String(r.url ?? '');
      const content = String(r.content ?? '');
      evidence.push({
        question, phase: 'breadth',
        title, url, content,
        rawContent: typeof r.raw_content === 'string' ? r.raw_content : '',
      });
      briefs.push({ question, title, url, content });
    }
  });
  return { briefs, evidence, failed };
}

// ---- 深度规划（LLM#2，只看 brief，不含 raw）----
export interface BuildDepthPlanOpts {
  task: string;
  config: ResearchConfig;
  intentSummary: string;   // 广度 intent_summary（可修订）
  breadthUsed: number;     // y = 广度实际使用次数
  briefs: BriefResult[];   // 广度 brief（title+url+content，不含 raw；送入 prompt 时 content 截首段）
  timeoutMs?: number;
  attempts?: number;
  chatFn?: (opts: ChatOpts) => Promise<ChatResult>;
}

export async function buildDepthPlan(opts: BuildDepthPlanOpts): Promise<DepthPlan> {
  const chat = opts.chatFn ?? chatCompletion;
  const { config } = opts;
  if (!config.apiKey) {
    throw new Error('research: 未配置主代理 key（RESEARCH_API_KEY）（卡在 research 深度规划）');
  }
  const minDepth = config.minDepth;
  const maxDepth = Math.max(0, config.maxSearches - opts.breadthUsed); // P2-1: breadthUsed 超限时钳 0，防 slice(0,-1)
  const briefText = opts.briefs.length === 0
    ? '(no usable breadth briefs)'
    : opts.briefs
        .map((b, i) => {
          // 只喂首段摘要：判断「覆盖了什么、缺什么」不需要全文，全文会挤掉 JSON 输出预算
          const head = b.content.length > RESEARCH_DEPTH_BRIEF_HEAD_CHARS
            ? b.content.slice(0, RESEARCH_DEPTH_BRIEF_HEAD_CHARS).trimEnd() + '…'
            : b.content;
          return `${i + 1}. [${b.question}] ${b.title} | ${b.url} | ${head}`;
        })
        .join('\n');
  const system = [
    'You are a research depth planner. Plan follow-up searches from the breadth briefs.',
    'Rules:',
    `- Count x is in [${minDepth}, ${maxDepth}] (advisory; do not pad to the max).`,
    '- Questions in English by default, self-contained, usable as search queries as-is. Keep proper nouns, version numbers, and error codes exactly as in the user task.',
    '- Deepen only entities, disputes, or gaps already present in intent_summary + briefs. Do not open unrelated new fronts.',
    '- Same query craft as breadth: one intent per question; chase missing primary evidence or contested points; do not rephrase breadth questions.',
    '- intent_summary may be revised.',
    'Output JSON only: {"intent_summary":"...","depth":[{"question":"...","reason":"..."}]}',
  ].join('\n');
  const attempts = opts.attempts ?? RESEARCH_PLAN_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? RESEARCH_PLAN_TIMEOUT_MS;
  let lastErr: unknown = null;
  let useJson = true;
  for (let i = 0; i < attempts; i++) {
    try {
      const { content } = await chat({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `Research task:\n${opts.task}\n\nBreadth intent: ${opts.intentSummary}\n\nBreadth briefs (${opts.breadthUsed} searches):\n${briefText}`,
          },
        ],
        json: useJson,
        maxTokens: 2000,
        timeoutMs,
      });
      const plan = parseDepthPlan(content);
      if (!plan) { lastErr = new Error('深度规划 JSON 形状非法'); continue; }
      return plan.depth.length > maxDepth
        ? { intentSummary: plan.intentSummary, depth: plan.depth.slice(0, maxDepth) }
        : plan;
    } catch (e) {
      lastErr = e;
      if (useJson && isResponseFormatError(e)) useJson = false;
    }
  }
  throw new Error(
    'research 深度规划失败（重试 ' + attempts + ' 次）（卡在 research 深度规划）: ' +
    (lastErr instanceof Error ? lastErr.message : String(lastErr))
  );
}

// ---- 深度执行（串行渐进；失败立即跳下一条，§6 深度失败）----
export interface DepthOutcome {
  evidence: EvidenceItem[];
  failed: FailedSearch[];
  executed: number; // 实际发起 search 的次数（deadline 放弃的深度不计）
}

export interface RunDepthOpts {
  plan: DepthPlan;
  searchFn: (params: { query: string; max_results: number; search_depth: string; include_raw_content: boolean }) => Promise<any>;
  maxResults?: number;
  deadlineMs?: number; // 总墙钟；循环内每条前检查，不足则放弃剩余 depth（§6）
}

export async function runDepthSearches(opts: RunDepthOpts): Promise<DepthOutcome> {
  const maxResults = opts.maxResults ?? RESEARCH_BREADTH_MAX_RESULTS;
  const evidence: EvidenceItem[] = [];
  const failed: FailedSearch[] = [];
  let executed = 0;
  for (let i = 0; i < opts.plan.depth.length; i++) {
    if (opts.deadlineMs && Date.now() >= opts.deadlineMs) {
      failed.push({
        question: '（剩余深度）',
        error: `总预算 ${RESEARCH_TOTAL_TIMEOUT_MS / 1000}s 近耗尽，放弃剩余 ${opts.plan.depth.length - i} 个深度`,
      });
      break;
    }
    const item = opts.plan.depth[i];
    executed++;
    try {
      const data = await opts.searchFn({
        query: item.question, max_results: maxResults, search_depth: 'basic', include_raw_content: true,
      });
      const results = data?.results;
      if (!Array.isArray(results)) {
        failed.push({ question: item.question, error: 'search 响应无 results 数组' });
        continue;
      }
      for (const r of results) {
        if (!r || typeof r !== 'object') continue;
        evidence.push({
          question: item.question,
          phase: 'depth',
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          content: String(r.content ?? ''),
          rawContent: typeof r.raw_content === 'string' ? r.raw_content : '',
        });
      }
    } catch (e) {
      failed.push({ question: item.question, error: e instanceof Error ? e.message : String(e) });
      // 立即跳下一条；总预算控制由外层 research() 负责（deadlineMs）
    }
  }
  return { evidence, failed, executed };
}

// ---- 综合报告（LLM#3，evidence 全量含 raw；failed 已脱敏进输入）----
export interface SynthesisOpts {
  task: string;
  config: ResearchConfig;
  intentSummary: string;
  evidence: EvidenceItem[];
  failed: FailedSearch[];
  timeoutMs?: number;
  attempts?: number;
  chatFn?: (opts: ChatOpts) => Promise<ChatResult>;
}

const SYNTHESIS_RAW_CHARS = 2000; // 单条 raw 截断，防撑爆模型上下文

export interface SynthesisResult {
  report: string;
  truncated: boolean; // finish_reason === 'length'（输出截断，报告可能不完整）
  usage: ChatUsage | null; // 截断诊断：本综合调用 token 用量（prompt/completion/total）
}

export async function synthesizeReport(opts: SynthesisOpts): Promise<SynthesisResult> {
  const chat = opts.chatFn ?? chatCompletion;
  const { config } = opts;
  if (!config.apiKey) {
    throw new Error('research: 未配置主代理 key（RESEARCH_API_KEY）（卡在 research 综合）');
  }
  const evidenceText = opts.evidence.map((e, i) => {
    const raw = e.rawContent.length > SYNTHESIS_RAW_CHARS
      ? e.rawContent.slice(0, SYNTHESIS_RAW_CHARS) + '…'
      : e.rawContent;
    return `${i + 1}. [${e.phase}] ${e.question}\n   ${e.title}\n   ${e.url}\n   ${e.content}${raw ? '\n   ' + raw : ''}`;
  }).join('\n');
  const failedText = opts.failed.length === 0
    ? '(none)'
    : opts.failed.map((f) => `${f.question}: ${redactSensitive(f.error)}`).join('\n');
  const system = [
    'You are a research synthesizer. Evidence is already retrieved and filtered; synthesize faithfully for a downstream LLM.',
    'Rules:',
    '- Output the report in English. You write for a downstream LLM agent whose working language is English; the agent handles presentation to the end user.',
    '- Use only the provided evidence. Mark gaps as uncovered. Do not invent facts or upgrade secondary claims into proven conclusions.',
    '- Be objective: no spin; do not alter meaning.',
    '- Length discipline: target ~5000–10000 output tokens (roughly a full report). Prefer bullets over long prose; one claim per line with its source URL.',
    '- Completeness over density: finish ALL planned sections (overview, every route, QEC, timeline, gaps). If space runs low, compress existing sections — never drop the tail. A shorter complete report beats a longer truncated one.',
  ].join('\n');
  const attempts = opts.attempts ?? RESEARCH_PLAN_MAX_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? RESEARCH_SYNTHESIS_TIMEOUT_MS;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const { content, finishReason, usage } = await chat({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `Research task:\n${opts.task}\n\nRevised intent: ${opts.intentSummary}\n\nEvidence (${opts.evidence.length} items):\n${evidenceText}\n\nFailed searches:\n${failedText}`,
          },
        ],
        // 不设 max_tokens：模型自由生成，唯一约束是 prompt 里的字数纪律（length discipline）
        timeoutMs,
      });
      const report = stripCodeFence(content).trim();
      if (!report) { lastErr = new Error('综合输出为空'); continue; }
      return { report, truncated: finishReason === 'length', usage };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    'research 综合失败（重试 ' + attempts + ' 次）（卡在 research 综合）: ' +
    (lastErr instanceof Error ? lastErr.message : String(lastErr))
  );
}

// ---- 返回标注（点数/次数/轮次/失败）----
export interface ResearchStats {
  breadth: number;   // y
  depth: number;     // x
  searches: number;  // N = y + x
  llmCalls: number;  // 模型调用次数（广度规划 + 深度规划 + 综合）
  searchRounds: number; // 1（广度并行）+ x（深度串行）
}

export function buildResearchAnnotation(stats: ResearchStats, failed: FailedSearch[]): string {
  const parts = [
    '---',
    'research 统计：',
    `- 搜索次数: ${stats.searches}（广度 ${stats.breadth} + 深度 ${stats.depth}；basic，1 点/次）`,
    `- 模型调用: ${stats.llmCalls} 次（广度规划${stats.depth ? ' + 深度规划' : ''} + 综合）`,
    `- 搜索轮次: ${stats.searchRounds}（1 波广度并行 + ${stats.depth} 波深度串行）`,
  ];
  if (failed.length) {
    const items = failed.map((f) => {
      const err = redactSensitive(f.error).replace(/\s+/g, ' ').trim();
      const clipped = err.length > 300 ? err.slice(0, 300) + '…' : err;
      return `${f.question}: ${clipped || '(no detail)'}`;
    });
    parts.push(`- 部分失败(${failed.length}): ${items.join('; ')}`);
  }
  return parts.join('\n');
}

// ---- 总编排（480s 总墙钟；先广并行、再深串行、最后综合）----
export interface RunResearchResult {
  report: string;
  annotation: string;
  error?: string; // 有则 isError
}

export interface RunResearchOpts {
  task: string;
  config: ResearchConfig;
  searchFn: (params: { query: string; max_results: number; search_depth: string; include_raw_content: boolean }) => Promise<any>;
  chatFn?: (opts: ChatOpts) => Promise<ChatResult>;
}

export async function runResearch(opts: RunResearchOpts): Promise<RunResearchResult> {
  const { config, task, searchFn } = opts;
  const chatFn = opts.chatFn ?? chatCompletion;
  const deadline = Date.now() + config.totalTimeoutMs; // 480s 总墙钟
  const stats: ResearchStats = { breadth: 0, depth: 0, searches: 0, llmCalls: 0, searchRounds: 0 };
  const allEvidence: EvidenceItem[] = [];
  const allFailed: FailedSearch[] = [];

  if (!config.apiKey) {
    return {
      report: '', annotation: '',
      error: 'research: 未配置主代理 key（RESEARCH_API_KEY）。可改用多次 deepseek_search。',
    };
  }

  // ① 广度规划（LLM#1）
  let breadthPlan: BreadthPlan;
  try {
    breadthPlan = await buildBreadthPlan({ task, config, chatFn });
    stats.llmCalls++;
  } catch (e) {
    return { report: '', annotation: '', error: e instanceof Error ? e.message : String(e) };
  }
  stats.breadth = breadthPlan.breadth.length;
  stats.searches = stats.breadth;
  stats.searchRounds = 1;

  if (Date.now() >= deadline) {
    return { report: '', annotation: '', error: `research 总预算 ${config.totalTimeoutMs / 1000}s 耗尽（卡在 research 广度搜索）` };
  }

  // ② 广度执行（并行 allSettled）
  const breadthOutcome = await runBreadthSearches({ plan: breadthPlan, searchFn });
  allEvidence.push(...breadthOutcome.evidence);
  allFailed.push(...breadthOutcome.failed);

  // ③ 深度规划（预算允许才做；maxDepth<0 防护）
  const maxDepth = Math.max(0, config.maxSearches - stats.breadth);
  let depthPlan: DepthPlan | null = null;
  if (maxDepth >= config.minDepth) {
    try {
      depthPlan = await buildDepthPlan({
        task, config, chatFn,
        intentSummary: breadthPlan.intentSummary,
        breadthUsed: stats.breadth,
        briefs: breadthOutcome.briefs,
      });
      stats.llmCalls++;
    } catch (e) {
      allFailed.push({ question: '（深度规划）', error: e instanceof Error ? e.message : String(e) });
      // 深度规划失败不致命：继续综合
    }
  }

  // ④ 深度执行（串行；每条前检查总墙钟）——统计按实际执行数，deadline 放弃的深度不计
  if (depthPlan && depthPlan.depth.length > 0) {
    const depthOutcome = await runDepthSearches({ plan: depthPlan, searchFn, deadlineMs: deadline });
    allEvidence.push(...depthOutcome.evidence);
    allFailed.push(...depthOutcome.failed);
    stats.depth = depthOutcome.executed;
    stats.searches += depthOutcome.executed;
    stats.searchRounds += depthOutcome.executed;
  }

  // ⑤ 无证据 → isError（不进入综合）
  if (allEvidence.length === 0) {
    const detail = allFailed.length
      ? '；失败: ' + allFailed.map((f) => f.question).join('; ')
      : '（未配置 Tavily key 或全部返回空）';
    return { report: '', annotation: '', error: `research: 广度与深度均无任何搜索结果${detail}` };
  }
  if (Date.now() >= deadline) {
    return { report: '', annotation: '', error: `research 总预算 ${config.totalTimeoutMs / 1000}s 耗尽（卡在 research 综合）` };
  }

  // ⑥ 综合（LLM#3）
  let report: string;
  let truncated = false;
  let synthesisUsage: ChatUsage | null = null;
  try {
    const syn = await synthesizeReport({
      task, config, chatFn,
      intentSummary: depthPlan ? depthPlan.intentSummary : breadthPlan.intentSummary,
      evidence: allEvidence,
      failed: allFailed,
    });
    report = syn.report;
    truncated = syn.truncated;
    synthesisUsage = syn.usage;
    stats.llmCalls++;
  } catch (e) {
    return {
      report: '', annotation: '',
      error: `research 综合失败: ${e instanceof Error ? e.message : String(e)}（已收集 ${allEvidence.length} 条证据，可用多次 deepseek_search 自行综合）`,
    };
  }

  let annotation = buildResearchAnnotation(stats, allFailed);
  if (truncated) {
    // 兜底诊断：正常情况无 max_tokens 帽不再 length；若仍 length（上游/模型自身限制），usage 说明卡点
    const usageText = synthesisUsage
      ? ` prompt=${synthesisUsage.promptTokens} completion=${synthesisUsage.completionTokens} total=${synthesisUsage.totalTokens}`
      : '';
    annotation += `\n- ⚠ 报告可能因输出截断未完整（finish_reason=length${usageText}）`;
  }
  return { report, annotation };
}
