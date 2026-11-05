import type { ChatTokenRate } from '@shared/chat';

const NS_PER_MS = 1_000_000;

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** From Ollama's final `/api/chat` frame, whose durations are nanoseconds. */
export function ollamaRate(frame: {
  eval_count?: unknown;
  eval_duration?: unknown;
  prompt_eval_count?: unknown;
  prompt_eval_duration?: unknown;
  load_duration?: unknown;
  total_duration?: unknown;
}): ChatTokenRate | undefined {
  const evalTokens = count(frame.eval_count);
  const evalNs = duration(frame.eval_duration);
  if (evalTokens === undefined || evalNs === undefined) return undefined;
  const promptTokens = count(frame.prompt_eval_count);
  const promptNs = duration(frame.prompt_eval_duration);
  const loadNs = duration(frame.load_duration);
  const totalNs = duration(frame.total_duration);
  return {
    evalTokens,
    evalMs: evalNs / NS_PER_MS,
    ...(promptTokens !== undefined && promptNs !== undefined ? { promptTokens, promptMs: promptNs / NS_PER_MS } : {}),
    ...(loadNs !== undefined ? { loadMs: loadNs / NS_PER_MS } : {}),
    ...(totalNs !== undefined ? { totalMs: totalNs / NS_PER_MS } : {}),
  };
}

/** From llama-server's `timings` object on an OpenAI-compatible stream chunk; durations are ms. */
export function llamaServerRate(timings: unknown): ChatTokenRate | undefined {
  if (!timings || typeof timings !== 'object') return undefined;
  const raw = timings as Record<string, unknown>;
  const evalTokens = count(raw.predicted_n);
  const evalMs = duration(raw.predicted_ms);
  if (evalTokens === undefined || evalMs === undefined) return undefined;
  const promptTokens = count(raw.prompt_n);
  const promptMs = duration(raw.prompt_ms);
  const cachedPromptTokens = count(raw.cache_n);
  const draftTokens = count(raw.draft_n);
  const draftAccepted = count(raw.draft_n_accepted);
  return {
    evalTokens,
    evalMs,
    ...(promptTokens !== undefined && promptMs !== undefined ? { promptTokens, promptMs } : {}),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(draftTokens !== undefined && draftTokens > 0 && draftAccepted !== undefined
      ? { draftTokens, draftAccepted }
      : {}),
  };
}

/** When the reply's deltas arrived, stamped once per network read. */
export interface StreamTiming {
  firstAt?: number;
  lastAt?: number;
  /** Distinct reads that carried a delta. */
  reads: number;
  /** Deltas that arrived in the first read; each is about one token, and their time is the prompt's. */
  firstReadDeltas?: number;
}

/** Below these, a buffered or bursty stream says more about the network than about generation. */
export const MIN_ESTIMATE_READS = 3;
export const MIN_ESTIMATE_SPAN_MS = 250;

/**
 * For a server that reports no timings: completion tokens over the wall time between the first
 * streamed token and the last. The first read's tokens arrived after the prompt, not during
 * generation, so they are not counted.
 */
export function estimatedRate(outputTokens: number | undefined, timing: StreamTiming): ChatTokenRate | undefined {
  const { firstAt, lastAt, reads, firstReadDeltas } = timing;
  if (outputTokens === undefined || firstAt === undefined || lastAt === undefined) return undefined;
  const evalMs = lastAt - firstAt;
  if (reads < MIN_ESTIMATE_READS || evalMs < MIN_ESTIMATE_SPAN_MS) return undefined;
  const untimedTokens = Math.max(1, firstReadDeltas ?? 1);
  const evalTokens = outputTokens - untimedTokens;
  if (evalTokens < 1) return undefined;
  return { evalTokens, evalMs, estimated: true, untimedTokens };
}

const RATE_FIELDS = [
  'evalTokens',
  'evalMs',
  'promptTokens',
  'promptMs',
  'loadMs',
  'totalMs',
  'cachedPromptTokens',
  'draftTokens',
  'draftAccepted',
  'untimedTokens',
] as const satisfies readonly (keyof ChatTokenRate)[];

/**
 * Sum two requests' timings, so the turn's rate is its tokens over its time; absent stays absent.
 * A round with no rate adds nothing, so the sum covers only the rounds that were timed.
 */
export function addTokenRate(
  total: ChatTokenRate | undefined,
  next: ChatTokenRate | undefined
): ChatTokenRate | undefined {
  if (!next) return total;
  if (!total) return next;
  const sum: ChatTokenRate = { evalTokens: 0, evalMs: 0 };
  for (const key of RATE_FIELDS) {
    if (total[key] !== undefined || next[key] !== undefined) sum[key] = (total[key] ?? 0) + (next[key] ?? 0);
  }
  if (total.estimated || next.estimated) sum.estimated = true;
  return sum;
}
