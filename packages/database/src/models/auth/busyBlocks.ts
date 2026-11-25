import { BUSY_BLOCK_LIMITS } from '@bike4mind/common';

export type BusyBlockInterval = { start: Date; end: Date };
export type BusyBlocksState = { enabled: boolean; blocks: BusyBlockInterval[]; nextBlockBriefAt: Date | null };

/**
 * Sorts and merges overlapping or touching blocks, then drops what can no longer get a brief: blocks ending
 * at or before `lastBlockBriefEnd` (already briefed), past the reconciler's retry window, or starting beyond
 * the sync horizon. A block straddling `lastBlockBriefEnd` keeps only its unbriefed tail.
 */
export function normalizeBusyBlocks(
  blocks: BusyBlockInterval[],
  { now, lastBlockBriefEnd }: { now: Date; lastBlockBriefEnd: Date | null }
): BusyBlockInterval[] {
  const sorted = blocks
    .map(({ start, end }) => ({ start: new Date(start), end: new Date(end) }))
    .filter(({ start, end }) => end.getTime() > start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: BusyBlockInterval[] = [];
  for (const block of sorted) {
    const last = merged[merged.length - 1];
    if (last && block.start.getTime() <= last.end.getTime()) {
      if (block.end.getTime() > last.end.getTime()) last.end = block.end;
    } else {
      merged.push(block);
    }
  }
  const staleBefore = now.getTime() - BUSY_BLOCK_LIMITS.retryWindowMs;
  const horizon = now.getTime() + BUSY_BLOCK_LIMITS.horizonMs;
  const briefedThrough = lastBlockBriefEnd?.getTime() ?? -Infinity;
  return merged
    .filter(
      ({ start, end }) => end.getTime() > briefedThrough && end.getTime() >= staleBefore && start.getTime() <= horizon
    )
    .map(({ start, end }) => ({ start: start.getTime() < briefedThrough ? new Date(briefedThrough) : start, end }));
}
