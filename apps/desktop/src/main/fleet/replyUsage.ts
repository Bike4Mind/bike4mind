import type { ChatUsage } from '@shared/chat';
import { MAX_USAGE_COUNT, isModelId, type ReplyUsage } from './activityContract';

/** A reply's running totals, in the units the wire carries. */
export type UsageTotals = Omit<ReplyUsage, 'model'>;

const count = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), MAX_USAGE_COUNT) : 0;

export function usageTotals(usage: ChatUsage | undefined): UsageTotals {
  return {
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    cacheReadTokens: count(usage?.cacheReadInputTokens),
    cacheWriteTokens: count(usage?.cacheCreationInputTokens),
    creditsMilli: count(usage?.creditsUsed === undefined ? undefined : usage.creditsUsed * 1000),
  };
}

/**
 * What a reply used beyond what it had already used when this run started. A resumed reply
 * carries the interrupted run's usage in its own totals, so reporting totals again would count
 * it twice; the stream's `start` event says where the run began, and that is `base`.
 * Null when the model id is not one Fleet can key on or nothing new was used.
 */
export function toReplyUsage(model: string | null, totals: UsageTotals, base?: UsageTotals): ReplyUsage | null {
  if (!model || !isModelId(model)) return null;
  const before = base ?? usageTotals(undefined);
  const delta: UsageTotals = {
    inputTokens: Math.max(0, totals.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, totals.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, totals.cacheReadTokens - before.cacheReadTokens),
    cacheWriteTokens: Math.max(0, totals.cacheWriteTokens - before.cacheWriteTokens),
    creditsMilli: Math.max(0, totals.creditsMilli - before.creditsMilli),
  };
  const used = Object.values(delta).reduce((sum, n) => sum + n, 0);
  return used > 0 ? { model, ...delta } : null;
}
