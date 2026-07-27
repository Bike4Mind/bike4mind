/**
 * The source registry (sec 5.5) as the drivers wire it.
 *
 * The registry is static data: every source is registered unconditionally and
 * `isConfigured` decides per run whether it fetches. A source that is absent
 * because of how a driver was wired is invisible - it never appears in a run
 * report at all - which is the failure this file exists to prevent.
 *
 * Real source factories, mocked repositories: no network, no AWS.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

/** Sentinel alias map, so "the seed export reaches the aggregators" is an identity check. */
const MODEL_ID_ALIASES = { 'grok-3-fast': { litellm: 'xai/grok-3-fast-latest' } };

const { rowsInForce, createBedrockControlPlane } = vi.hoisted(() => ({
  rowsInForce: vi.fn(),
  createBedrockControlPlane: vi.fn(() => ({
    listFoundationModels: vi.fn(),
    getFoundationModelAvailability: vi.fn(),
  })),
}));

vi.mock('@bike4mind/database', () => ({
  MODEL_ID_ALIASES,
  modelCatalogRepository: { rowsInForce, append: vi.fn(), rowsInForceWithRejects: vi.fn() },
  modelDiscoveryStateRepository: { recordSighting: vi.fn(), recordMiss: vi.fn() },
  modelDiscoveryRunRepository: { create: vi.fn(), update: vi.fn(), find: vi.fn() },
  cacheRepository: { claimDedup: vi.fn(), deleteByKey: vi.fn() },
  adminSettingsRepository: { getSettingsValue: vi.fn(), findBySettingName: vi.fn() },
  apiKeyRepository: { find: vi.fn() },
}));
vi.mock('./bedrockControlPlane', () => ({ createBedrockControlPlane }));

// Real factories, wrapped so the options each one was handed are readable.
const captured = {
  bedrock: undefined as { client: unknown; activeModelIds?: () => unknown } | undefined,
  modelsDev: undefined as { targets: () => unknown; aliases?: unknown } | undefined,
  litellm: undefined as { targets: () => unknown; aliases?: unknown } | undefined,
};

vi.mock('@bike4mind/services', async importOriginal => {
  const actual = (await importOriginal()) as typeof import('@bike4mind/services');
  const real = actual.modelDiscoveryService;
  return {
    ...actual,
    modelDiscoveryService: {
      ...real,
      createBedrockSource: (options: never) => {
        captured.bedrock = options;
        return real.createBedrockSource(options);
      },
      createModelsDevSource: (options: never) => {
        captured.modelsDev = options;
        return real.createModelsDevSource(options);
      },
      createLiteLlmSource: (options: never) => {
        captured.litellm = options;
        return real.createLiteLlmSource(options);
      },
    },
  };
});

const { buildModelDiscoveryAdapters } = await import('./adapters');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** rowsInForce returns catalog rows; the merge resolves them per field group. */
const catalogRow = (modelId: string, backend: string, status: string) => ({
  modelId,
  schemaVersion: 1,
  source: 'seed',
  ownedGroups: ['identity', 'lifecycle'],
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  patch: { id: modelId, backend, lifecycle: { status } },
});

beforeEach(() => {
  rowsInForce.mockResolvedValue([
    catalogRow('claude-sonnet-5', 'anthropic', 'active'),
    catalogRow('us.anthropic.claude-sonnet-9', 'bedrock', 'discovered'),
    catalogRow('grok-3-fast', 'xai', 'active'),
  ]);
});

afterEach(() => {
  captured.bedrock = undefined;
  captured.modelsDev = undefined;
  captured.litellm = undefined;
  vi.clearAllMocks();
});

describe('the source registry', () => {
  it('registers every source unconditionally', () => {
    const names = buildModelDiscoveryAdapters(logger).sources.map(source => source.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'openai',
        'anthropic',
        'xai',
        'gemini',
        'ollama',
        'bfl',
        'elevenlabs',
        'bedrock',
        'models.dev',
        'litellm',
      ])
    );
    expect(names).toHaveLength(10);
  });

  it('registers no duplicates: the report and the min-interval guard key on name', () => {
    const names = buildModelDiscoveryAdapters(logger).sources.map(source => source.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('hands the runner complete sources', () => {
    for (const source of buildModelDiscoveryAdapters(logger).sources) {
      expect(typeof source.isConfigured, source.name).toBe('function');
      expect(typeof source.fetch, source.name).toBe('function');
      expect(['provider', 'aggregator']).toContain(source.kind);
    }
  });

  it('reads nothing at wiring time: every catalog and AWS touch is deferred to the run', () => {
    buildModelDiscoveryAdapters(logger);
    expect(rowsInForce).not.toHaveBeenCalled();
    expect(createBedrockControlPlane).not.toHaveBeenCalled();
  });
});

describe('bedrock wiring', () => {
  it('passes a thunk so the SDK client is built only when the source runs', async () => {
    buildModelDiscoveryAdapters(logger);
    expect(typeof captured.bedrock?.client).toBe('function');
    expect(createBedrockControlPlane).not.toHaveBeenCalled();

    await (captured.bedrock!.client as () => unknown)();
    expect(createBedrockControlPlane).toHaveBeenCalledTimes(1);
  });

  it('probes availability only for models the catalog does not already hold as active', async () => {
    buildModelDiscoveryAdapters(logger);
    const active = await captured.bedrock!.activeModelIds!();

    expect(active).toEqual(new Set(['claude-sonnet-5', 'grok-3-fast']));
    // The 'discovered' Bedrock id is absent, so it still gets its entitlement call.
    expect((active as Set<string>).has('us.anthropic.claude-sonnet-9')).toBe(false);
  });
});

describe('aggregator wiring', () => {
  it('gives both aggregators the whole catalog as join targets', async () => {
    buildModelDiscoveryAdapters(logger);

    for (const options of [captured.modelsDev!, captured.litellm!]) {
      const targets = (await options.targets()) as Array<{ modelId: string; backend?: string }>;
      expect(targets).toEqual(
        expect.arrayContaining([
          { modelId: 'claude-sonnet-5', backend: 'anthropic' },
          { modelId: 'us.anthropic.claude-sonnet-9', backend: 'bedrock' },
          { modelId: 'grok-3-fast', backend: 'xai' },
        ])
      );
    }
  });

  it('passes the checked-in alias seed through to both', () => {
    buildModelDiscoveryAdapters(logger);
    expect(captured.modelsDev?.aliases).toBe(MODEL_ID_ALIASES);
    expect(captured.litellm?.aliases).toBe(MODEL_ID_ALIASES);
  });
});

describe('the shared catalog read', () => {
  it('reads once per run no matter how many sources ask', async () => {
    buildModelDiscoveryAdapters(logger);

    await Promise.all([
      captured.bedrock!.activeModelIds!(),
      captured.modelsDev!.targets(),
      captured.litellm!.targets(),
    ]);

    expect(rowsInForce).toHaveBeenCalledTimes(1);
  });

  it('takes a fresh snapshot for the next run', async () => {
    await buildModelDiscoveryAdapters(logger).sources.length;
    await captured.modelsDev!.targets();
    buildModelDiscoveryAdapters(logger);
    await captured.modelsDev!.targets();

    expect(rowsInForce).toHaveBeenCalledTimes(2);
  });

  it('degrades a failed catalog read to an empty view rather than a failed run', async () => {
    rowsInForce.mockRejectedValue(new Error('mongo is down'));
    buildModelDiscoveryAdapters(logger);

    await expect(captured.modelsDev!.targets()).resolves.toEqual([]);
    await expect(captured.bedrock!.activeModelIds!()).resolves.toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('catalog read failed'));
  });
});
