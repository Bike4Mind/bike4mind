import { describe, it, expect, afterEach, vi } from 'vitest';
import { ChatModels, ModelBackend } from '@bike4mind/common';
import type { IModelCatalogRow } from '@bike4mind/common';
import { getAvailableModels, setModelCatalogProvider, setModelPriceRowsProvider } from './index';
import { replacedByOverlayEntries, resetReplacedByOverlay } from './resolveDeprecatedModel';

// apiKeys=null assembles only the keyless backends (Bedrock/AWS/BFL), all
// static - no network. Pick a Bedrock text model as the overlay target.
const TARGET = ChatModels.CLAUDE_4_5_SONNET_BEDROCK;

const row: IModelCatalogRow = {
  modelId: TARGET,
  schemaVersion: 1,
  source: 'discovery',
  ownedGroups: ['presentation'],
  patch: { rank: 4242 },
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
};

afterEach(() => {
  setModelCatalogProvider(null);
  setModelPriceRowsProvider(null);
  resetReplacedByOverlay();
});

describe('getAvailableModels model catalog provider', () => {
  it('overlays catalog rows onto the assembled models', async () => {
    setModelCatalogProvider(async () => [row]);

    const models = await getAvailableModels(null);
    expect(models.find(m => m.id === TARGET)?.rank).toBe(4242);
  });

  it('falls back to the adapter tables when the provider throws', async () => {
    setModelCatalogProvider(async () => {
      throw new Error('db down');
    });

    const models = await getAvailableModels(null);
    const target = models.find(m => m.id === TARGET);
    expect(target).toBeDefined();
    expect(target!.rank).not.toBe(4242);
  });

  it('uses the adapter tables when no provider is wired', async () => {
    const models = await getAvailableModels(null);
    expect(models.find(m => m.id === TARGET)!.rank).not.toBe(4242);
  });

  it('busts the model cache on wiring, so a freshly wired catalog does not wait out a stale TTL', async () => {
    const before = await getAvailableModels(null);
    expect(before.find(m => m.id === TARGET)!.rank).not.toBe(4242);

    setModelCatalogProvider(async () => [row]);

    const after = await getAvailableModels(null);
    expect(after.find(m => m.id === TARGET)!.rank).toBe(4242);
  });

  it('caches the merged list (provider is called once per rebuild, not per request)', async () => {
    let calls = 0;
    setModelCatalogProvider(async () => {
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
      setModelCatalogProvider(async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient mongo blip');
        return [row];
      });

      const literal = await getAvailableModels(null);
      expect(literal.find(m => m.id === TARGET)!.rank).not.toBe(4242);

      // Still inside the retry window: serves the cached adapter-table fallback.
      vi.advanceTimersByTime(10_000);
      await getAvailableModels(null);
      expect(calls).toBe(1);

      // Past the 30s retry window (but far inside the normal 5min TTL): refetches.
      vi.advanceTimersByTime(25_000);
      const recovered = await getAvailableModels(null);
      expect(calls).toBe(2);
      expect(recovered.find(m => m.id === TARGET)!.rank).toBe(4242);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the replacedBy overlay when a later read comes back empty', async () => {
    // An empty read is no information, same as a failed one: wiping the overlay
    // would strand every catalog successor until the next non-empty read.
    const sunset: IModelCatalogRow = {
      modelId: 'ancient-9',
      schemaVersion: 1,
      source: 'discovery',
      ownedGroups: ['lifecycle'],
      patch: { lifecycle: { status: 'deprecated', replacedBy: 'grok-9' } },
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    };

    setModelCatalogProvider(async () => [sunset]);
    await getAvailableModels(null);
    expect(replacedByOverlayEntries().get('ancient-9')).toBe('grok-9');

    setModelCatalogProvider(async () => []);
    await getAvailableModels(null);
    expect(replacedByOverlayEntries().get('ancient-9')).toBe('grok-9');
  });

  it('runs the catalog merge before the price overlay, so a catalog-only model can still be priced', async () => {
    setModelCatalogProvider(async () => [
      {
        modelId: 'grok-9',
        schemaVersion: 1,
        source: 'discovery',
        ownedGroups: ['identity', 'limits', 'dispatch', 'lifecycle'],
        patch: {
          id: 'grok-9',
          vendor: 'xai',
          backend: ModelBackend.XAI,
          type: 'text',
          name: 'Grok 9',
          contextWindow: 2_000_000,
          adapterFamily: 'xai',
          dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'chat' },
          lifecycle: { status: 'active' },
        },
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    setModelPriceRowsProvider(async () => [
      {
        modelId: 'grok-9',
        unit: 'per_token',
        pricing: { '0': { input: 1e-6, output: 3e-6 } },
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const models = await getAvailableModels({ xai: 'xai-key' });
    expect(models.find(m => m.id === 'grok-9')?.pricing).toEqual({ 0: { input: 1e-6, output: 3e-6 } });
  });
});
