import { describe, it, expect, afterEach, vi } from 'vitest';
import { ChatModels, type IModelPrice } from '@bike4mind/common';
import { getAvailableModels, setModelPriceRowsProvider } from './index';

// apiKeys=null assembles only the keyless backends (Bedrock/AWS/BFL), all
// static - no network. Pick a Bedrock text model as the overlay target.
const TARGET = ChatModels.CLAUDE_4_5_SONNET_BEDROCK;

const row: IModelPrice = {
  modelId: TARGET,
  unit: 'per_token',
  pricing: { '200000': { input: 42 / 1_000_000, output: 84 / 1_000_000 } },
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

afterEach(() => {
  // Unset provider (also clears the module-level model cache).
  setModelPriceRowsProvider(null);
});

describe('getAvailableModels price catalog provider', () => {
  it('overlays catalog prices onto the assembled models', async () => {
    setModelPriceRowsProvider(async () => [row]);

    const models = await getAvailableModels(null);
    const target = models.find(m => m.id === TARGET);
    expect(target?.pricing[200_000]).toEqual({ input: 42 / 1_000_000, output: 84 / 1_000_000 });
  });

  it('falls back to adapter literals when the provider throws', async () => {
    setModelPriceRowsProvider(async () => {
      throw new Error('db down');
    });

    const models = await getAvailableModels(null);
    const target = models.find(m => m.id === TARGET);
    expect(target).toBeDefined();
    expect(target!.pricing[200_000].input).not.toBe(42 / 1_000_000);
  });

  it('uses adapter literals when no provider is wired', async () => {
    const models = await getAvailableModels(null);
    const target = models.find(m => m.id === TARGET);
    expect(target).toBeDefined();
    expect(target!.pricing[200_000].input).not.toBe(42 / 1_000_000);
  });

  it('caches the overlaid list (provider is called once per rebuild, not per request)', async () => {
    let calls = 0;
    setModelPriceRowsProvider(async () => {
      calls += 1;
      return [row];
    });

    await getAvailableModels(null);
    await getAvailableModels(null);
    expect(calls).toBe(1);
  });

  it('caches a failed catalog fetch briefly, not for the full TTL (transient blip recovers in seconds)', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      setModelPriceRowsProvider(async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient mongo blip');
        return [row];
      });

      const literal = await getAvailableModels(null);
      expect(literal.find(m => m.id === TARGET)!.pricing[200_000].input).not.toBe(42 / 1_000_000);

      // Still inside the retry window: serves the cached literal fallback.
      vi.advanceTimersByTime(10_000);
      await getAvailableModels(null);
      expect(calls).toBe(1);

      // Past the 30s retry window (but far inside the normal 5min TTL): refetches and overlays.
      vi.advanceTimersByTime(25_000);
      const recovered = await getAvailableModels(null);
      expect(calls).toBe(2);
      expect(recovered.find(m => m.id === TARGET)!.pricing[200_000].input).toBe(42 / 1_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
