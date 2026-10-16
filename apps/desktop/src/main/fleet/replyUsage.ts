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

/** The larger of each field: a figure already reported never goes back down. */
export function mergeTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    creditsMilli: Math.max(a.creditsMilli, b.creditsMilli),
  };
}

/**
 * What a reply used beyond what was already reported for it. A resumed reply carries the
 * interrupted run's usage in its own totals, so reporting totals again would count it twice.
 * Null when the model id is not one Fleet can key on or nothing new was used.
 */
export function toReplyUsage(model: string | null, totals: UsageTotals, reported?: UsageTotals): ReplyUsage | null {
  if (!model || !isModelId(model)) return null;
  const before = reported ?? usageTotals(undefined);
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
