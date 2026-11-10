import { describe, it, expect, afterEach, vi } from 'vitest';
import { ChatModels, ModelBackend } from '@bike4mind/common';
import type { IModelCatalogRow } from '@bike4mind/common';
import {
  MODEL_LIST_REVISION_READ_DEADLINE_MS,
  RUNTIME_DISCOVERED_BACKENDS,
  getAvailableModels,
  seededModelIds,
  setModelCatalogProvider,
  setModelListRevisionProvider,
  setModelPriceRowsProvider,
} from './index';
import { replacedByOverlayEntries, resetReplacedByOverlay } from './resolveDeprecatedModel';
import { AnthropicBackend } from './anthropicBackend';
import { directTwinId } from './routeTwinNames';

// apiKeys=null assembles only the keyless backends (Bedrock/AWS/BFL), all
// static - no network. Pick a Bedrock text model as the overlay target.
const TARGET = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;

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
  setModelListRevisionProvider(null);
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

  it('renames a Bedrock route after its direct twin even when a discovery row named it', async () => {
    setModelCatalogProvider(async () => [{ ...row, ownedGroups: ['identity'], patch: { name: 'AWS Listing Name' } }]);

    const models = await getAvailableModels(null);
    const target = models.find(m => m.id === TARGET)!;
    const twinId = directTwinId(target);
    const direct = (await new AnthropicBackend('static-listing').getModelInfo()).find(m => m.id === twinId);
    expect(direct).toBeDefined();
    expect(target.name).toBe(direct!.name);
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

  describe('catalogRevision', () => {
    const countingProvider = () => {
      const calls = { count: 0 };
      setModelCatalogProvider(async () => {
        calls.count += 1;
        return [row];
      });
      return calls;
    };

    it('rebuilds when a caller reports a revision this process has not seen', async () => {
      const calls = countingProvider();

      await getAvailableModels(null, { catalogRevision: 'rev-a' });
      await getAvailableModels(null, { catalogRevision: 'rev-a' });
      expect(calls.count).toBe(1);

      await getAvailableModels(null, { catalogRevision: 'rev-b' });
      expect(calls.count).toBe(2);
    });

    it('serves callers that pass no revision from the list built under the newest one', async () => {
      const calls = countingProvider();

      await getAvailableModels(null, { catalogRevision: 'rev-c' });
      await getAvailableModels(null);
      expect(calls.count).toBe(1);
    });

    it('does not keep a list whose build started before a newer revision was reported', async () => {
      const pending: Array<() => void> = [];
      let calls = 0;
      setModelCatalogProvider(async () => {
        calls += 1;
        if (calls > 2) return [row];
        return new Promise<IModelCatalogRow[]>(resolve => pending.push(() => resolve([row])));
      });

      const older = getAvailableModels(null, { catalogRevision: 'rev-d' });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const newer = getAvailableModels(null, { catalogRevision: 'rev-e' });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      pending[1]();
      await newer;
      // The older build lands last and overwrites the slot, stamped with the revision it started under.
      pending[0]();
      await older;

      await getAvailableModels(null, { catalogRevision: 'rev-e' });
      expect(calls).toBe(3);
    });

    it('shares one build between concurrent misses for the same revision', async () => {
      const calls = countingProvider();

      await Promise.all([
        getAvailableModels(null, { catalogRevision: 'rev-f' }),
        getAvailableModels(null, { catalogRevision: 'rev-f' }),
      ]);

      expect(calls.count).toBe(1);
    });
  });

  describe('model-list revision provider', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rebuilds for a caller that passes no revision once the provider reports a new one', async () => {
      vi.useFakeTimers();
      const calls = { count: 0 };
      setModelCatalogProvider(async () => {
        calls.count += 1;
        return [row];
      });
      let shared = 'rev-1';
      setModelListRevisionProvider(async () => shared);

      await getAvailableModels(null);
      await getAvailableModels(null);
      expect(calls.count).toBe(1);

      shared = 'rev-2';
      vi.advanceTimersByTime(5_000);
      await getAvailableModels(null);
      expect(calls.count).toBe(2);
    });

    it('reads the revision at most once per memo window', async () => {
      vi.useFakeTimers();
      const reads = { count: 0 };
      setModelListRevisionProvider(async () => {
        reads.count += 1;
        return 'rev-1';
      });

      await Promise.all([getAvailableModels(null), getAvailableModels(null)]);
      vi.advanceTimersByTime(4_000);
      await getAvailableModels(null);
      expect(reads.count).toBe(1);

      vi.advanceTimersByTime(1_000);
      await getAvailableModels(null);
      expect(reads.count).toBe(2);
    });

    it('keeps the cached list when the revision read fails', async () => {
      vi.useFakeTimers();
      const calls = { count: 0 };
      setModelCatalogProvider(async () => {
        calls.count += 1;
        return [row];
      });
      let failing = false;
      setModelListRevisionProvider(async () => {
        if (failing) throw new Error('cache unreachable');
        return 'rev-1';
      });

      await getAvailableModels(null);
      failing = true;
      vi.advanceTimersByTime(5_000);
      await getAvailableModels(null);

      expect(calls.count).toBe(1);
    });

    it('serves the cached list within the deadline while the revision read hangs, then applies the late answer', async () => {
      vi.useFakeTimers();
      const calls = { count: 0 };
      setModelCatalogProvider(async () => {
        calls.count += 1;
        return [row];
      });
      let answerLate: (revision: string) => void = () => {};
      let hanging = false;
      setModelListRevisionProvider(async () => {
        if (!hanging) return 'rev-1';
        return new Promise<string>(resolve => {
          answerLate = resolve;
        });
      });
      await getAvailableModels(null);

      hanging = true;
      vi.advanceTimersByTime(5_000);
      let served = false;
      const stalled = getAvailableModels(null).then(models => {
        served = true;
        return models;
      });
      await vi.advanceTimersByTimeAsync(MODEL_LIST_REVISION_READ_DEADLINE_MS - 1);
      expect(served).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(served).toBe(true);
      expect((await stalled).find(m => m.id === TARGET)?.rank).toBe(4242);
      expect(calls.count).toBe(1);

      // Inside the memo window that the timeout opened, a caller does not wait on the stuck read again.
      let servedAgain = false;
      void getAvailableModels(null).then(() => {
        servedAgain = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(servedAgain).toBe(true);

      answerLate('rev-2');
      await vi.advanceTimersByTimeAsync(0);
      await getAvailableModels(null);
      expect(calls.count).toBe(2);
    });

    it('prefers a revision the caller passes over the memoized one', async () => {
      const calls = { count: 0 };
      setModelCatalogProvider(async () => {
        calls.count += 1;
        return [row];
      });
      setModelListRevisionProvider(async () => 'rev-1');

      await getAvailableModels(null);
      await getAvailableModels(null, { catalogRevision: 'rev-2' });
      await getAvailableModels(null);

      expect(calls.count).toBe(2);
    });
  });

  describe('onCatalogUnavailable', () => {
    it('reports an adapter-table fallback, and replays it on the cached list', async () => {
      setModelCatalogProvider(async () => {
        throw new Error('db down');
      });
      const onCatalogUnavailable = vi.fn();

      await getAvailableModels(null, { onCatalogUnavailable });
      await getAvailableModels(null, { onCatalogUnavailable });

      expect(onCatalogUnavailable).toHaveBeenCalledTimes(2);
    });

    it('reports a failed price overlay too', async () => {
      setModelPriceRowsProvider(async () => {
        throw new Error('db down');
      });
      const onCatalogUnavailable = vi.fn();

      await getAvailableModels(null, { onCatalogUnavailable });

      expect(onCatalogUnavailable).toHaveBeenCalledTimes(1);
    });

    it('stays quiet when both overlays were read', async () => {
      setModelCatalogProvider(async () => [row]);
      setModelPriceRowsProvider(async () => []);
      const onCatalogUnavailable = vi.fn();

      await getAvailableModels(null, { onCatalogUnavailable });

      expect(onCatalogUnavailable).not.toHaveBeenCalled();
    });
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

  it('bounds a hanging catalog read instead of waiting out mongo socket timeout', async () => {
    vi.useFakeTimers();
    try {
      // Never settles: the deadline is the only thing that can end this read.
      setModelCatalogProvider(() => new Promise<IModelCatalogRow[]>(() => {}));

      const pending = getAvailableModels(null);
      await vi.advanceTimersByTimeAsync(5_000);
      const models = await pending;

      // Degraded to the assembled adapter tables, not hung and not empty.
      expect(models.find(m => m.id === TARGET)).toBeDefined();
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

describe('seededModelIds', () => {
  it('covers every model a static-table backend of getAvailableModels lists, BFL included', async () => {
    const keys = Object.fromEntries(
      Object.values(ModelBackend)
        .filter(backend => !RUNTIME_DISCOVERED_BACKENDS.includes(backend))
        .map(backend => [backend, `${backend}-key`])
    );
    const listed = await getAvailableModels(keys, { isSelfHost: false, bedrockReachable: true });
    const seeded = await seededModelIds();

    expect(listed.some(model => model.backend === ModelBackend.BFL)).toBe(true);
    expect(listed.map(model => model.id).filter(id => !seeded.has(id))).toEqual([]);
  });
});
