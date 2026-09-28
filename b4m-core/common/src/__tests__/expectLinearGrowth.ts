import { expect } from 'vitest';

// Same shape and constants as assertLinearGrowth in b4m-core/utils/src/artifactParser.test.ts.
// Pick `small` so the linear code stays well under MIN_BASELINE_MS at 2x (the floored ratio is
// then a ~75ms budget that load does not reach), while a quadratic scan is far above it.
const MIN_BASELINE_MS = 25;
const GROWTH_RATIO_CEILING = 3;
const SMALL_INPUT_MS_CEILING = 500;

function bestOfThreeMs(input: string, run: (input: string) => unknown): number {
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = performance.now();
    run(input);
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
}

export function expectLinearGrowth(build: (n: number) => string, run: (input: string) => unknown, small: number) {
  const baselineMs = bestOfThreeMs(build(small), run);
  expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
  const doubledMs = bestOfThreeMs(build(small * 2), run);
  expect(doubledMs / Math.max(baselineMs, MIN_BASELINE_MS)).toBeLessThan(GROWTH_RATIO_CEILING);
}
