import { describe, expect, it } from 'vitest';
import { findDrift, planNativeFiles } from './nativeOutputs';

describe('committed native token files', () => {
  it('match what the emitters produce from the tokens', async () => {
    // On failure: run `pnpm --filter @bike4mind/design-tokens generate:native` (or `make
    // generate-tokens` in apps/ios) and commit the result.
    expect(await findDrift()).toEqual([]);
  });

  it('writes every emitted file somewhere', () => {
    expect(planNativeFiles().length).toBeGreaterThan(0);
  });
});
