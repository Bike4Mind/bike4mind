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
}): ChatTokenRate | undefined {
  const evalTokens = count(frame.eval_count);
  const evalNs = duration(frame.eval_duration);
  if (evalTokens === undefined || evalNs === undefined) return undefined;
  const promptTokens = count(frame.prompt_eval_count);
  const promptNs = duration(frame.prompt_eval_duration);
  const loadNs = duration(frame.load_duration);
  return {
    evalTokens,
    evalMs: evalNs / NS_PER_MS,
    ...(promptTokens !== undefined && promptNs !== undefined ? { promptTokens, promptMs: promptNs / NS_PER_MS } : {}),
    ...(loadNs !== undefined ? { loadMs: loadNs / NS_PER_MS } : {}),
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
  const draftTokens = count(raw.draft_n);
  const draftAccepted = count(raw.draft_n_accepted);
  return {
    evalTokens,
    evalMs,
    ...(promptTokens !== undefined && promptMs !== undefined ? { promptTokens, promptMs } : {}),
    ...(draftTokens !== undefined && draftTokens > 0 && draftAccepted !== undefined
      ? { draftTokens, draftAccepted }
      : {}),
  };
}

/**
 * For a server that reports no timings: completion tokens over the wall time between the first
 * streamed token and the last. The first token's own time is the prompt's, so it is not counted.
 */
export function estimatedRate(
  outputTokens: number | undefined,
  firstAt: number | undefined,
  lastAt: number | undefined
): ChatTokenRate | undefined {
  if (outputTokens === undefined || outputTokens < 2 || firstAt === undefined || lastAt === undefined) return undefined;
  const evalMs = lastAt - firstAt;
  return evalMs > 0 ? { evalTokens: outputTokens - 1, evalMs, estimated: true } : undefined;
}

const RATE_FIELDS = [
  'evalTokens',
  'evalMs',
  'promptTokens',
  'promptMs',
  'loadMs',
  'draftTokens',
  'draftAccepted',
] as const satisfies readonly (keyof ChatTokenRate)[];

/** Sum two requests' timings, so the turn's rate is its tokens over its time; absent stays absent. */
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
