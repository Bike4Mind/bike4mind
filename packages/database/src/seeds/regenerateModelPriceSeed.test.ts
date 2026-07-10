import { describe, it, expect } from 'vitest';
import { buildModelPriceSeedFile } from './regenerateModelPriceSeed';
import { generateModelPriceSeed } from './generateModelPriceSeed';

describe('buildModelPriceSeedFile', () => {
  it('stamps generatedAt from the given time and regenerates entries together', async () => {
    // Bumping generatedAt alongside entries is what makes seedModelPrices
    // treat regenerated prices as a new version; a hand-edit that skips the
    // bump is silently dropped by the alreadyCurrent skip.
    const now = new Date('2026-07-10T06:00:00Z');
    const file = await buildModelPriceSeedFile(now);
    expect(file.generatedAt).toBe(now.toISOString());
    expect(file.entries).toEqual(await generateModelPriceSeed());
  });
});
