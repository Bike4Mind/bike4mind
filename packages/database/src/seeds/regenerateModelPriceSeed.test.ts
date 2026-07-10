import { describe, it, expect } from 'vitest';
import { buildModelPriceSeedFile } from './regenerateModelPriceSeed';

describe('buildModelPriceSeedFile', () => {
  it('stamps generatedAt from the given time alongside regenerated entries', async () => {
    // Bumping generatedAt alongside entries is what makes seedModelPrices
    // treat regenerated prices as a new version; a hand-edit that skips the
    // bump is silently dropped by the alreadyCurrent skip. Entry correctness
    // itself is covered by the freshness test in modelPriceSeed.test.ts.
    const now = new Date('2026-07-10T06:00:00Z');
    const file = await buildModelPriceSeedFile(now);
    expect(file.generatedAt).toBe(now.toISOString());
    expect(file.entries.length).toBeGreaterThan(0);
    expect(file.entries[0]).toHaveProperty('modelId');
    expect(file.entries[0]).toHaveProperty('pricing');
  });
});
