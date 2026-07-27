/**
 * T8 drivers: the hosted cron handler and the self-host worker's scheduled task
 * must reach `runModelDiscovery` with the same wiring. Asserted against one spy
 * so a driver that grows its own adapters fails here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { runModelDiscovery, repos, emitMetrics, connectDB, sourceFactories } = vi.hoisted(() => {
  // One stub instance per source name, so two builds of the adapters produce
  // arrays that compare equal and the registry stays inspectable by name.
  const stubs = new Map<string, unknown>();
  const factory = (name: string) => () => {
    if (!stubs.has(name)) {
      stubs.set(name, { name, kind: 'provider', isConfigured: () => false, fetch: async () => ({ ok: false }) });
    }
    return stubs.get(name);
  };
  return {
    runModelDiscovery: vi.fn(),
    emitMetrics: vi.fn(async () => {}),
    connectDB: vi.fn(async () => undefined),
    sourceFactories: {
      createOpenAiSource: factory('openai'),
      createAnthropicSource: factory('anthropic'),
      createXaiSource: factory('xai'),
      createGeminiSource: factory('gemini'),
      createOllamaSource: factory('ollama'),
      createBflSource: factory('bfl'),
      createElevenLabsSource: factory('elevenlabs'),
      createBedrockSource: factory('bedrock'),
      createModelsDevSource: factory('models.dev'),
      createLiteLlmSource: factory('litellm'),
    },
    repos: {
      modelCatalogRepository: { append: vi.fn(), rowsInForceWithRejects: vi.fn(), rowsInForce: vi.fn(async () => []) },
      modelDiscoveryStateRepository: { recordSighting: vi.fn(), recordMiss: vi.fn() },
      modelDiscoveryRunRepository: { create: vi.fn(), update: vi.fn(), find: vi.fn(), lastSuccessfulRun: vi.fn() },
      modelPriceRepository: { append: vi.fn(), rowsInForce: vi.fn(async () => []) },
      cacheRepository: { claimDedup: vi.fn(), deleteByKey: vi.fn() },
      adminSettingsRepository: { getSettingsValue: vi.fn(), findBySettingName: vi.fn(), findBySettingNames: vi.fn() },
      apiKeyRepository: { find: vi.fn() },
    },
  };
});

vi.mock('@bike4mind/database', () => ({ connectDB, MODEL_ID_ALIASES: {}, ...repos }));
vi.mock('@bike4mind/services', () => ({
  modelDiscoveryService: {
    runModelDiscovery,
    getDiscoveryCredentials: vi.fn(),
    DEFAULT_BUDGET_MS: 600_000,
    ...sourceFactories,
  },
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetrics }));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const runResult = (overrides: Record<string, unknown> = {}) => ({
  outcome: 'ok',
  mode: 'report',
  autoEnable: 'priced',
  sources: [],
  skippedSources: [],
  diff: [],
  droppedRecords: [],
  absence: { sighted: [], missed: [], frozenBackends: [] },
  metrics: {
    ModelsDiscovered: 0,
    ModelsPromoted: 0,
    ModelsBlockedByDispatch: 0,
    ModelsDeprecated: 0,
    PriceRowsAppended: 0,
    PriceFlagged: 0,
    CatalogRowsRejected: 0,
    AggregatorJoinCoverage: {},
    SourceFailures: {},
    RunDuration: 12,
  },
  ...overrides,
});

const { runScheduledDiscovery } = await import('./scheduledRun');
const { handler } = await import('@server/cron/modelDiscovery');

beforeEach(() => {
  runModelDiscovery.mockResolvedValue(runResult());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runScheduledDiscovery', () => {
  it('wires the discovery repositories and the dispatch resolver', async () => {
    await runScheduledDiscovery(logger, 'selfhost');

    const [adapters] = runModelDiscovery.mock.calls[0];
    expect(adapters.db).toEqual({
      catalog: repos.modelCatalogRepository,
      discoveryState: repos.modelDiscoveryStateRepository,
      discoveryRuns: repos.modelDiscoveryRunRepository,
      prices: repos.modelPriceRepository,
      cache: repos.cacheRepository,
      adminSettings: repos.adminSettingsRepository,
    });
    // Without a resolver every discovered model stays metadata-only.
    expect(typeof adapters.resolveDispatch).toBe('function');
    expect(typeof adapters.resolveCredentials).toBe('function');
    // A run with no sources is a no-op that still writes a clean report, so an
    // empty registry has to fail here rather than in production.
    expect(adapters.sources.length).toBeGreaterThan(0);
  });

  it('labels the run with the host it was given and defaults the trigger to cron', async () => {
    await runScheduledDiscovery(logger, 'selfhost');
    expect(runModelDiscovery.mock.calls[0][1]).toEqual({ trigger: 'cron', host: 'selfhost' });
  });

  it('omits budgetMs rather than passing undefined, so the service default applies', async () => {
    await runScheduledDiscovery(logger, 'selfhost');
    expect('budgetMs' in runModelDiscovery.mock.calls[0][1]).toBe(false);
  });
});

describe('hosted cron handler', () => {
  it('runs discovery with the hosted label and the lambda budget', async () => {
    await handler({ trigger: 'cron' });

    expect(connectDB).toHaveBeenCalledTimes(1);
    expect(runModelDiscovery.mock.calls[0][1]).toEqual({ trigger: 'cron', host: 'hosted', budgetMs: 600_000 });
  });

  it('passes a manual invocation through as trigger manual', async () => {
    await handler({ trigger: 'manual' });
    expect(runModelDiscovery.mock.calls[0][1]).toMatchObject({ trigger: 'manual' });
  });

  it('treats an unknown event trigger as the scheduled one', async () => {
    await handler({ trigger: 'nonsense' as 'cron' });
    expect(runModelDiscovery.mock.calls[0][1]).toMatchObject({ trigger: 'cron' });
  });

  it('uses the same adapters the worker task does', async () => {
    await handler({});
    const fromCron = runModelDiscovery.mock.calls[0][0];
    runModelDiscovery.mockClear();

    await runScheduledDiscovery(logger, 'selfhost');
    const fromWorker = runModelDiscovery.mock.calls[0][0];

    expect(fromCron.db).toEqual(fromWorker.db);
    // By name: each build makes its own closures, and the registry is what has
    // to match, not the object identities.
    expect(fromCron.sources.map((s: { name: string }) => s.name)).toEqual(
      fromWorker.sources.map((s: { name: string }) => s.name)
    );
    expect(fromCron.resolveDispatch).toBe(fromWorker.resolveDispatch);
  });

  it('emits the run metrics', async () => {
    await handler({});
    expect(emitMetrics).toHaveBeenCalledTimes(1);
    const [namespace, data] = emitMetrics.mock.calls[0];
    expect(namespace).toBe('Lumina5/ModelDiscovery');
    expect(data.map((d: { name: string }) => d.name)).toContain('ModelsDiscovered');
  });

  it('emits nothing for a skipped run, so lease contention is not a zero-discovery run', async () => {
    runModelDiscovery.mockResolvedValue(runResult({ outcome: 'skipped', skipReason: 'lease-held' }));
    await handler({});
    expect(emitMetrics).not.toHaveBeenCalled();
  });
});
