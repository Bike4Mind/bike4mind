import type { ChatReplyStats, ChatReplyStatsEstimate } from './chat';

const ESTIMATES: ReadonlySet<string> = new Set<ChatReplyStatsEstimate>(['reasoningMs', 'reasoningTokens']);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const OPTIONAL_NUMBERS = [
  'loadMs',
  'firstTokenLoadMs',
  'waitMs',
  'firstTokenWaitMs',
  'outputMs',
  'firstTokenMs',
  'reasoningMs',
  'reasoningTokens',
] as const;

/**
 * A stored message's stats as the shape the types promise: fields of the wrong type are dropped, and
 * stats with no usable totals are none. Stored messages are read raw, so every reader goes through this.
 */
export function readReplyStats(value: unknown): ChatReplyStats | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const { totalMs, modelMs, toolMs } = raw;
  if (!finite(totalMs) || !finite(modelMs) || !finite(toolMs)) return undefined;
  const stats: ChatReplyStats = { totalMs, modelMs, toolMs };
  for (const key of OPTIONAL_NUMBERS) {
    const field = raw[key];
    if (finite(field)) stats[key] = field;
  }
  const { generation, derived } = raw;
  if (typeof generation === 'object' && generation !== null) {
    const { tokens, ms, untimedTokens, outputTokens } = generation as Record<string, unknown>;
    if (finite(tokens) && finite(ms)) {
      stats.generation = {
        tokens,
        ms,
        ...(finite(untimedTokens) ? { untimedTokens } : {}),
        ...(finite(outputTokens) ? { outputTokens } : {}),
      };
    }
  }
  if (Array.isArray(derived)) {
    const known = derived.filter(
      (estimate): estimate is ChatReplyStatsEstimate => typeof estimate === 'string' && ESTIMATES.has(estimate)
    );
    if (known.length > 0) stats.derived = known;
  }
  return stats;
}
