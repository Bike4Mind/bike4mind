import { describe, expect, it } from 'vitest';
import {
  compareForcedRetrievalRank,
  forcedRetrievalRelativeCutoff,
  type ForcedRetrievalRankable,
} from './forcedRetrievalFloors';

describe('forcedRetrievalRelativeCutoff', () => {
  it('is the requested fraction of the turn top score', () => {
    expect(forcedRetrievalRelativeCutoff(0.914, 0.85)).toBeCloseTo(0.7769, 4);
  });

  it('returns 0 when the floor is off, so the caller takes its unfiltered branch', () => {
    expect(forcedRetrievalRelativeCutoff(0.914, 0)).toBe(0);
  });

  it('never cuts the head of the ranking, at any floor up to 100%', () => {
    // The setting caps at 100, so the fraction is at most 1 and the cutoff is at most `topScore`.
    // With the `>=` comparison at the call sites, the best candidate always survives its own
    // cutoff - the floor cannot starve a turn that had anything to serve.
    const topScore = 0.83;
    expect(topScore).toBeGreaterThanOrEqual(forcedRetrievalRelativeCutoff(topScore, 1));
  });

  it('disarms on a non-positive top score rather than inverting across zero', () => {
    // 0.85 * -0.2 = -0.17, which is ABOVE the score it came from: a naive multiply would put the
    // cutoff over every candidate and empty the pool. Unreachable on the served path (its absolute
    // floor is positive) but reachable from the sweep, which takes arbitrary floor pairs.
    expect(forcedRetrievalRelativeCutoff(-0.2, 0.85)).toBe(0);
    expect(forcedRetrievalRelativeCutoff(0, 0.85)).toBe(0);
  });
});

describe('compareForcedRetrievalRank', () => {
  const c = (score: number, fileId: string, chunkId: string): ForcedRetrievalRankable => ({
    score,
    fileId,
    chunkId,
  });

  it('orders by score descending', () => {
    expect(compareForcedRetrievalRank(c(0.9, 'f', 'a'), c(0.8, 'f', 'b'))).toBeLessThan(0);
  });

  it('breaks a score tie on fileId, then chunkId', () => {
    expect(compareForcedRetrievalRank(c(0.9, 'f1', 'z'), c(0.9, 'f2', 'a'))).toBeLessThan(0);
    expect(compareForcedRetrievalRank(c(0.9, 'f1', 'a'), c(0.9, 'f1', 'b'))).toBeLessThan(0);
  });

  it('returns 0 only for the same ranking identity', () => {
    expect(compareForcedRetrievalRank(c(0.9, 'f1', 'a'), c(0.9, 'f1', 'a'))).toBe(0);
  });

  it('is a total order, so a sort cannot depend on arrival order', () => {
    // This is the property both callers rely on: the served path for stable citation numbering
    // across two identical turns, the sweep for which candidates survive the pool cap.
    const candidates = [c(0.9, 'f2', 'b'), c(0.9, 'f1', 'b'), c(0.95, 'f9', 'z'), c(0.9, 'f1', 'a')];
    const forward = [...candidates].sort(compareForcedRetrievalRank);
    const reversed = [...candidates].reverse().sort(compareForcedRetrievalRank);
    expect(forward).toEqual(reversed);
    expect(forward.map(x => `${x.fileId}/${x.chunkId}`)).toEqual(['f9/z', 'f1/a', 'f1/b', 'f2/b']);
  });
});
