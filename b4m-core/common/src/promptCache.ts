import { parseClaudeModelId } from './claudeModelId';
import { ModelBackend, type TurnUsage } from './models';

export const PROMPT_CACHE_TTLS = ['5m', '1h'] as const;
export type PromptCacheTtl = (typeof PROMPT_CACHE_TTLS)[number];

export const DEFAULT_PROMPT_CACHE_TTL: PromptCacheTtl = '5m';

/** How long an entry lives after the start of the last request that wrote or read it. */
export const PROMPT_CACHE_TTL_MS: Record<PromptCacheTtl, number> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

export function isPromptCacheTtl(value: unknown): value is PromptCacheTtl {
  return typeof value === 'string' && (PROMPT_CACHE_TTLS as readonly string[]).includes(value);
}

/**
 * Whether a model can be sent `cache_control.ttl: "1h"`: Claude on the direct API or Bedrock, limited
 * to the models the Claude API reference lists as current (Haiku 4.5, the 4.6+ Sonnet and Opus, and
 * every 5.x family), so an older model never sees a TTL it may reject.
 */
export function supportsOneHourPromptCache(model: { id: string; backend?: string } | undefined): boolean {
  if (!model || (model.backend !== ModelBackend.Anthropic && model.backend !== ModelBackend.Bedrock)) return false;
  const parsed = parseClaudeModelId(model.id);
  if (!parsed) return false;
  if (parsed.major >= 5) return true;
  if (parsed.major < 4) return false;
  const minor = parsed.minor ?? 0;
  return parsed.family === 'haiku' ? minor >= 5 : minor >= 6;
}

/**
 * The TTL a chat's requests use: the chat's own choice, else the user's default, else 5 minutes.
 * Always 5 minutes on a model that cannot take the 1-hour TTL.
 */
export function resolvePromptCacheTtl({
  model,
  chatTtl,
  userDefaultTtl,
}: {
  model: { id: string; backend?: string } | undefined;
  chatTtl?: unknown;
  userDefaultTtl?: unknown;
}): PromptCacheTtl {
  if (!supportsOneHourPromptCache(model)) return DEFAULT_PROMPT_CACHE_TTL;
  if (isPromptCacheTtl(chatTtl)) return chatTtl;
  if (isPromptCacheTtl(userDefaultTtl)) return userDefaultTtl;
  return DEFAULT_PROMPT_CACHE_TTL;
}

/**
 * A turn whose adapter did not split its writes by TTL wrote them all at the request's TTL, since
 * every breakpoint the server sets carries it. Turns that report the split keep their own count.
 */
export function withRequestTtlWrites(turns: TurnUsage[], cacheTtl: PromptCacheTtl): TurnUsage[] {
  if (cacheTtl !== '1h') return turns;
  return turns.map(turn =>
    turn.cacheWrite1hInputTokens === undefined && turn.cacheCreationInputTokens
      ? { ...turn, cacheWrite1hInputTokens: turn.cacheCreationInputTokens }
      : turn
  );
}

/** The 1-hour part of an aggregate write count: the adapter's split when reported, else the request TTL's. */
export function oneHourWritesOf(
  cacheCreationTokens: number,
  reportedOneHourTokens: number | undefined,
  cacheTtl: PromptCacheTtl
): number {
  const oneHour = reportedOneHourTokens ?? (cacheTtl === '1h' ? cacheCreationTokens : 0);
  return Math.min(Math.max(oneHour, 0), cacheCreationTokens);
}
