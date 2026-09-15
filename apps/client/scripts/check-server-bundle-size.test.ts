// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs build script, intentionally not part of the TS program
import {
  evaluateBudget,
  topContributors,
  worstStatus,
  LAMBDA_UNZIPPED_LIMIT_BYTES,
} from './check-server-bundle-size.mjs';

const LIMIT = LAMBDA_UNZIPPED_LIMIT_BYTES;
const BUDGET = Math.floor(LIMIT * 0.9);

describe('evaluateBudget', () => {
  it('holds the documented Lambda limit, so a silent edit cannot loosen the gate', () => {
    // 250 MiB. Hard-coded rather than derived: AWS does not expose it and it is not adjustable.
    expect(LIMIT).toBe(262144000);
  });

  it.each([
    ['well under budget', 100_000_000, 'ok'],
    ['exactly at budget', BUDGET, 'ok'],
    ['one byte over budget', BUDGET + 1, 'over-budget'],
    ['exactly at the AWS limit', LIMIT, 'over-budget'],
    ['over the AWS limit', LIMIT + 1, 'over-limit'],
  ])('classifies %s (%d bytes) as %s', (_label, totalBytes, expected) => {
    expect(evaluateBudget({ totalBytes }).status).toBe(expected);
  });

  it('reports the real pre-fix bundle as over budget while still deployable', () => {
    // The measured size of the deployed bundle that preceded the googleapis narrowing. AWS
    // accepted it, yet it was only 17.9 MB from rejection - precisely the state this budget
    // exists to surface rather than discover through a failed deploy.
    const result = evaluateBudget({ totalBytes: 243_393_532 });
    expect(result.status).toBe('over-budget');
    expect(result.percentOfLimit).toBeCloseTo(92.8, 1);
  });

  it('computes headroom against the limit, not the budget', () => {
    expect(evaluateBudget({ totalBytes: LIMIT - 1_048_576 }).headroomBytes).toBe(1_048_576);
  });

  it('honours an explicit budget fraction', () => {
    expect(evaluateBudget({ totalBytes: 200_000_000, budgetFraction: 0.5 }).status).toBe('over-budget');
    expect(evaluateBudget({ totalBytes: 200_000_000, budgetFraction: 0.99 }).status).toBe('ok');
  });
});

describe('worstStatus', () => {
  it.each([
    [['ok', 'ok'], 'ok'],
    [['ok', 'over-budget'], 'over-budget'],
    [['over-budget', 'over-limit', 'ok'], 'over-limit'],
    [[], 'ok'],
  ])('reduces %j to %s', (statuses, expected) => {
    expect(worstStatus(statuses)).toBe(expected);
  });
});

describe('topContributors', () => {
  it('groups by the first three path segments so the culprit is named, not just node_modules', () => {
    const files: Array<[string, number]> = [
      ['node_modules/.pnpm/googleapis@173.0.0/build/one.js', 30],
      ['node_modules/.pnpm/googleapis@173.0.0/build/two.js', 5],
      ['node_modules/.pnpm/tiktoken@1.0.22/index.js', 20],
      ['apps/client/.next/server/page.js', 10],
    ];

    expect(topContributors(files)).toEqual([
      ['node_modules/.pnpm/googleapis@173.0.0', 35],
      ['node_modules/.pnpm/tiktoken@1.0.22', 20],
      ['apps/client/.next', 10],
    ]);
  });

  it('limits the list to the requested count', () => {
    const files: Array<[string, number]> = Array.from({ length: 30 }, (_unused, i) => [`a/b/pkg${i}/f.js`, i]);
    expect(topContributors(files, 3)).toHaveLength(3);
  });

  it('handles a shallow path without inventing segments', () => {
    expect(topContributors([['index.mjs', 7]])).toEqual([['index.mjs', 7]]);
  });
});
