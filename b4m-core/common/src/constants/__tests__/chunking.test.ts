import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN_SERVE_BOUND,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  MIN_PASSAGE_TOKEN_TARGET,
  SERVE_CHUNK_CHARS_CEILING,
  SERVE_CHUNK_CHARS_FLOOR,
  deriveServeCharBudget,
} from '../chunking';

/** The serve cap before it was derived from the chunk policy. Nothing may regress below it. */
const HISTORICAL_SERVE_CAP = 1200;

describe('deriveServeCharBudget', () => {
  it('serves a full default-policy chunk without clipping, which the historical cap could not', () => {
    const { maxChunkChars, chunkTokenTarget, ceilingBound } = deriveServeCharBudget(undefined);

    expect(chunkTokenTarget).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
    expect(maxChunkChars).toBe(DEFAULT_PASSAGE_TOKEN_TARGET * CHARS_PER_TOKEN_SERVE_BOUND);
    expect(ceilingBound).toBe(false);
    // The whole point of the change: the default policy's chunk no longer exceeds its serve budget.
    expect(maxChunkChars).toBeGreaterThan(HISTORICAL_SERVE_CAP);
    // Pinned literally, not as an expression of the constants, so retuning the bound has to come
    // with a human looking at this number - it is the figure the change is argued from.
    expect(maxChunkChars).toBe(3072);
  });

  it('scales with an operator-configured token target', () => {
    expect(deriveServeCharBudget(1000).maxChunkChars).toBe(1000 * CHARS_PER_TOKEN_SERVE_BOUND);
  });

  it('never serves less than the historical cap, even at the smallest usable chunk size', () => {
    // MIN_PASSAGE_TOKEN_TARGET * bound is well under the floor, so the floor is what applies.
    expect(MIN_PASSAGE_TOKEN_TARGET * CHARS_PER_TOKEN_SERVE_BOUND).toBeLessThan(SERVE_CHUNK_CHARS_FLOOR);
    expect(deriveServeCharBudget(MIN_PASSAGE_TOKEN_TARGET).maxChunkChars).toBe(SERVE_CHUNK_CHARS_FLOOR);
  });

  it('raises a below-floor target instead of honoring it, exactly as the chunker does', () => {
    const belowFloor = deriveServeCharBudget(MIN_PASSAGE_TOKEN_TARGET - 1);

    expect(belowFloor.chunkTokenTarget).toBe(MIN_PASSAGE_TOKEN_TARGET);
    expect(belowFloor.maxChunkChars).toBe(SERVE_CHUNK_CHARS_FLOOR);
  });

  it('clamps a very large target to the ceiling and reports that the cap is below the policy', () => {
    // A target this size is what the pre-passage-granularity chunker produced (model window minus
    // its buffer), and lakes ingested then still hold chunks of it.
    const huge = deriveServeCharBudget(6554);

    expect(huge.maxChunkChars).toBe(SERVE_CHUNK_CHARS_CEILING);
    // ceilingBound is the signal the resolver turns into an operator warning: past here the serve
    // cap and the chunk policy genuinely disagree, and clipping is expected rather than a bug.
    expect(huge.ceilingBound).toBe(true);
  });

  it('binds the ceiling only once the derivation actually exceeds it', () => {
    // The boundary pair: the largest target that still fits, and the first one that does not.
    const largestFitting = Math.floor(SERVE_CHUNK_CHARS_CEILING / CHARS_PER_TOKEN_SERVE_BOUND);
    const fits = deriveServeCharBudget(largestFitting);
    const overflows = deriveServeCharBudget(largestFitting + 1);

    expect(fits.maxChunkChars).toBe(largestFitting * CHARS_PER_TOKEN_SERVE_BOUND);
    expect(fits.maxChunkChars).toBeLessThanOrEqual(SERVE_CHUNK_CHARS_CEILING);
    expect(fits.ceilingBound).toBe(false);

    expect(overflows.maxChunkChars).toBe(SERVE_CHUNK_CHARS_CEILING);
    expect(overflows.ceilingBound).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -512],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('falls back to the chunker default for an unusable target (%s)', (_label, value) => {
    const budget = deriveServeCharBudget(value as number | null | undefined);

    expect(budget.chunkTokenTarget).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
    expect(budget.maxChunkChars).toBe(DEFAULT_PASSAGE_TOKEN_TARGET * CHARS_PER_TOKEN_SERVE_BOUND);
  });

  it('floors a fractional target rather than serving against a size the chunker cannot use', () => {
    expect(deriveServeCharBudget(512.9).chunkTokenTarget).toBe(512);
  });
});

describe('serve-budget constants', () => {
  it('bounds chars per token above the prose average, so an in-policy chunk is not clipped', () => {
    // ~4 chars/token is the English-prose average; a budget built on the average clips about half
    // of in-policy chunks, which is the defect this replaces rather than a fix for it.
    expect(CHARS_PER_TOKEN_SERVE_BOUND).toBeGreaterThan(4);
  });

  it('keeps the floor below the ceiling so the clamp cannot invert', () => {
    expect(SERVE_CHUNK_CHARS_FLOOR).toBeLessThan(SERVE_CHUNK_CHARS_CEILING);
  });

  it('pins the floor to the historical serve cap', () => {
    expect(SERVE_CHUNK_CHARS_FLOOR).toBe(HISTORICAL_SERVE_CAP);
  });
});
