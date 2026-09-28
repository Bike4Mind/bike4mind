import { expect } from 'vitest';

// Same best-of-3 and floored baseline as assertLinearGrowth in b4m-core/utils/src/artifactParser.test.ts,
// but measured n against 4n with an 8x ceiling: linear lands near 4x and quadratic near 16x, so
// CI runner noise cannot push one across the bound the way it could at 2x against 3x.
const MIN_BASELINE_MS = 25;
const GROWTH_RATIO_CEILING = 8;
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
  const quadrupledMs = bestOfThreeMs(build(small * 4), run);
  expect(quadrupledMs / Math.max(baselineMs, MIN_BASELINE_MS)).toBeLessThan(GROWTH_RATIO_CEILING);
}
