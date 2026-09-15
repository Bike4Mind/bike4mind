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

/**
 * Parity against the code these helpers were extracted from.
 *
 * The extraction was meant to be behavior-preserving, and `ChatCompletionFeatures.test.ts` passing
 * both before and after cannot show that - it passes either way. The reference implementations below
 * are the pre-extraction expressions VERBATIM (the cutoff from the forced-retrieval scan, the
 * comparator from `compareForcedRetrievalCandidates`), so any future change to the shared helpers
 * that would move the served path fails here and says so.
 */
describe('parity with the pre-extraction served path', () => {
  const legacyCutoff = (topScore: number, relativeFloor: number): number =>
    relativeFloor > 0 && topScore > 0 ? topScore * relativeFloor : 0;

  type LegacyCandidate = { score: number; fabFileId: string; id: string };
  const legacyCompare = (a: LegacyCandidate, b: LegacyCandidate): number => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.fabFileId !== b.fabFileId) return a.fabFileId < b.fabFileId ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  /** Deterministic PRNG, so a parity failure reproduces exactly instead of on one unlucky run. */
  const nextRandom = (seed: number): (() => number) => {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  };

  it('computes the same relative cutoff over the whole input domain', () => {
    const random = nextRandom(7);
    // Deliberately includes negative and zero top scores and a 0 floor: those are the branches the
    // extraction moved, so they are the ones parity has to cover.
    const topScores = [-1, -0.2, 0, 0.0001, 0.75, 0.914, 1, ...Array.from({ length: 40 }, () => random() * 2 - 1)];
    const floors = [0, 0.01, 0.5, 0.85, 0.95, 1, ...Array.from({ length: 20 }, () => random())];
    for (const topScore of topScores) {
      for (const floor of floors) {
        expect(forcedRetrievalRelativeCutoff(topScore, floor)).toBe(legacyCutoff(topScore, floor));
      }
    }
  });

  it('produces the same total order, including ties on every tiebreak level', () => {
    const random = nextRandom(11);
    // A small id/score alphabet on purpose: it forces collisions on score alone, on score+file, and
    // on all three, which is where a comparator rewrite actually goes wrong.
    const candidates = Array.from({ length: 200 }, () => ({
      score: Math.round(random() * 4) / 4,
      fabFileId: `f${Math.floor(random() * 3)}`,
      id: `c${Math.floor(random() * 5)}`,
    }));

    const legacyOrder = [...candidates].sort(legacyCompare).map(c => `${c.score}|${c.fabFileId}|${c.id}`);
    const sharedOrder = [...candidates]
      .sort((a, b) =>
        compareForcedRetrievalRank(
          { score: a.score, fileId: a.fabFileId, chunkId: a.id },
          { score: b.score, fileId: b.fabFileId, chunkId: b.id }
        )
      )
      .map(c => `${c.score}|${c.fabFileId}|${c.id}`);

    expect(sharedOrder).toEqual(legacyOrder);
  });

  it('agrees on the sign of every pairwise comparison, not just the sorted result', () => {
    // A sort can agree while the comparator disagrees on individual pairs, and it is the pairwise
    // contract the in-scan trim depends on.
    const random = nextRandom(13);
    for (let i = 0; i < 500; i++) {
      const pair = Array.from({ length: 2 }, () => ({
        score: Math.round(random() * 3) / 3,
        fabFileId: `f${Math.floor(random() * 2)}`,
        id: `c${Math.floor(random() * 3)}`,
      })) as [LegacyCandidate, LegacyCandidate];
      const legacy = legacyCompare(pair[0], pair[1]);
      const shared = compareForcedRetrievalRank(
        { score: pair[0].score, fileId: pair[0].fabFileId, chunkId: pair[0].id },
        { score: pair[1].score, fileId: pair[1].fabFileId, chunkId: pair[1].id }
      );
      expect(Math.sign(shared)).toBe(Math.sign(legacy));
    }
  });
});
