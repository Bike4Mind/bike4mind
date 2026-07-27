import { ModelBackend, type SettingKey } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeAdminSettingsRepository,
  FakeCacheRepository,
  FakeCatalogRepository,
  FakeDiscoveryStateRepository,
  FakePriceRepository,
  FakeRunRepository,
  stubSource,
  testCredentials,
} from './__fixtures__/fakes';
import { DISCOVERY_LEASE_KEY, runModelDiscovery } from './runModelDiscovery';
import type {
  DiscoveredModel,
  DiscoveryLogger,
  DiscoverySource,
  ModelDiscoveryAdapters,
  RunModelDiscoveryOptions,
} from './types';

const START = new Date('2026-07-26T10:00:00Z');

const gpt6: DiscoveredModel = {
  modelId: 'gpt-6',
  patch: {
    id: 'gpt-6',
    vendor: 'openai',
    backend: ModelBackend.OpenAI,
    type: 'text',
    name: 'GPT-6',
    contextWindow: 400_000,
  },
  pricing: { inputPerMTok: 2, outputPerMTok: 8 },
};

const openaiSource = (records: DiscoveredModel[] = [gpt6]) =>
  stubSource({ name: 'openai', kind: 'provider', records, authoritativeFor: [ModelBackend.OpenAI] });

const dispatchResolver: ModelDiscoveryAdapters['resolveDispatch'] = () => ({
  adapterFamily: 'openai-chat',
  dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
});

interface Harness {
  adapters: ModelDiscoveryAdapters;
  cache: FakeCacheRepository;
  catalog: FakeCatalogRepository;
  prices: FakePriceRepository;
  state: FakeDiscoveryStateRepository;
  runs: FakeRunRepository;
  warnings: string[];
  advance: (ms: number) => void;
  options: RunModelDiscoveryOptions;
}

function harness(sources: DiscoverySource[], settings: Partial<Record<SettingKey, unknown>> = {}): Harness {
  let clock = START.getTime();
  const cache = new FakeCacheRepository();
  cache.now = () => new Date(clock);
  const catalog = new FakeCatalogRepository();
  const prices = new FakePriceRepository();
  const state = new FakeDiscoveryStateRepository();
  const runs = new FakeRunRepository();
  const warnings: string[] = [];
  const logger: DiscoveryLogger = { info: () => {}, warn: message => warnings.push(message), error: () => {} };

  return {
    cache,
    catalog,
    prices,
    state,
    runs,
    warnings,
    advance: (ms: number) => {
      clock += ms;
    },
    adapters: {
      db: {
        catalog,
        discoveryState: state,
        discoveryRuns: runs,
        cache,
        adminSettings: new FakeAdminSettingsRepository({ modelDiscoveryMode: 'write', ...settings }),
        prices,
      },
      logger,
      sources,
      resolveCredentials: async () => testCredentials(),
      resolveDispatch: dispatchResolver,
      env: {},
    },
    options: {
      trigger: 'cron',
      host: 'hosted',
      // Every source is eligible on every run unless a test says otherwise.
      minSourceIntervalMs: 0,
      now: () => new Date(clock),
    },
  };
}

describe('runModelDiscovery', () => {
  let bench: Harness;

  beforeEach(() => {
    bench = harness([openaiSource()]);
  });

  it('writes a promoted catalog row and records the sighting', async () => {
    const result = await runModelDiscovery(bench.adapters, bench.options);

    expect(result.outcome).toBe('ok');
    expect(bench.catalog.rows).toHaveLength(1);
    expect(bench.catalog.rows[0]).toMatchObject({ modelId: 'gpt-6', source: 'discovery', runId: 'run-1' });
    expect(bench.catalog.rows[0].effectiveFrom).toEqual(START);
    expect(bench.state.sightings).toEqual(['gpt-6']);
    expect(result.metrics).toMatchObject({ ModelsDiscovered: 1, ModelsPromoted: 1, ModelsBlockedByDispatch: 0 });
  });

  it('appends nothing on a second run over identical source data', async () => {
    await runModelDiscovery(bench.adapters, bench.options);
    bench.advance(60_000);
    const second = await runModelDiscovery(bench.adapters, bench.options);

    expect(bench.catalog.rows).toHaveLength(1);
    expect(second.diff).toEqual([]);
    expect(second.outcome).toBe('ok');
  });

  it('writes nothing at all in report mode while still emitting the diff', async () => {
    const reporting = harness([openaiSource()], { modelDiscoveryMode: 'report' });

    const result = await runModelDiscovery(reporting.adapters, reporting.options);

    expect(reporting.catalog.rows).toEqual([]);
    expect(reporting.state.sightings).toEqual([]);
    expect(reporting.state.misses).toEqual([]);
    expect(result.mode).toBe('report');
    expect(result.diff).toHaveLength(1);
    expect(result.diff[0]).toMatchObject({ modelId: 'gpt-6', kind: 'added', promoted: true });
    // The run report itself is always written: it is how the diff is read.
    expect(reporting.runs.docs).toHaveLength(1);
  });

  it('defaults to report mode when the setting is unset', async () => {
    const defaulted = harness([openaiSource()], {});
    // The harness sets 'write'; an explicitly unset value must fall back to the
    // shipped default, which is the soak mode.
    defaulted.adapters.db.adminSettings = new FakeAdminSettingsRepository();

    const result = await runModelDiscovery(defaulted.adapters, defaulted.options);

    expect(result.mode).toBe('report');
    expect(defaulted.catalog.rows).toEqual([]);
  });

  it('does nothing when discovery is disabled', async () => {
    const off = harness([openaiSource()], { enableModelDiscovery: false });

    const result = await runModelDiscovery(off.adapters, off.options);

    expect(result).toMatchObject({ outcome: 'skipped', skipReason: 'disabled' });
    expect(off.runs.docs).toEqual([]);
    expect(off.cache.entries.size).toBe(0);
  });

  it('skips every source, provider APIs included, when egress is forbidden', async () => {
    const walled = harness([openaiSource(), stubSource({ name: 'models.dev', kind: 'aggregator' })], {
      modelDiscoveryAllowEgress: false,
    });

    const result = await runModelDiscovery(walled.adapters, walled.options);

    expect(result.skippedSources).toEqual([
      { name: 'openai', reason: 'egress-disabled' },
      { name: 'models.dev', reason: 'egress-disabled' },
    ]);
    // Nothing was verified, so the run must not read as a successful refresh.
    expect(result.outcome).toBe('partial');
    expect(walled.catalog.rows).toEqual([]);
  });

  it('skips a source another host fetched successfully within the interval', async () => {
    await runModelDiscovery(bench.adapters, bench.options);
    bench.advance(60_000);

    const result = await runModelDiscovery(bench.adapters, { ...bench.options, minSourceIntervalMs: 30 * 60_000 });

    expect(result.skippedSources).toEqual([{ name: 'openai', reason: 'recently-fetched' }]);
    expect(result.outcome).toBe('partial');
  });

  it('skips a source with no credential without failing the run', async () => {
    const partial = harness([openaiSource(), stubSource({ name: 'xai', configured: false })]);

    const result = await runModelDiscovery(partial.adapters, partial.options);

    expect(result.skippedSources).toEqual([{ name: 'xai', reason: 'not-configured' }]);
    expect(result.outcome).toBe('partial');
    expect(partial.catalog.rows).toHaveLength(1);
  });

  describe('deadlines', () => {
    it('commits the sources that finished and reports partial when one hangs', async () => {
      const hung = harness([openaiSource(), stubSource({ name: 'slow-provider', hang: true })]);

      const result = await runModelDiscovery(hung.adapters, { ...hung.options, budgetMs: 1_000 });

      expect(result.outcome).toBe('partial');
      // lastSuccessfulRun is derived from status === 'ok', so a partial run
      // cannot advance it.
      expect(hung.runs.docs[0].status).toBe('partial');
      expect(hung.catalog.rows).toHaveLength(1);
      expect(result.sources.find(report => report.name === 'slow-provider')).toMatchObject({ ok: false });
      expect(result.metrics.SourceFailures).toEqual({ openai: 0, 'slow-provider': 1 });
    });

    it('retries a failed source once and gives up', async () => {
      let calls = 0;
      const flaky = harness([
        stubSource({
          name: 'flaky',
          onFetch: () => {
            calls += 1;
          },
          result: { ok: false, error: 'HTTP 500' },
        }),
      ]);

      const result = await runModelDiscovery(flaky.adapters, flaky.options);

      expect(calls).toBe(2);
      expect(result.outcome).toBe('failed');
      expect(result.sources[0]).toMatchObject({ name: 'flaky', ok: false, error: 'HTTP 500' });
    });
  });

  describe('lease', () => {
    it('is a no-op for a second concurrent invocation', async () => {
      await bench.cache.claimDedup(DISCOVERY_LEASE_KEY, { claimedAt: START.toISOString() }, 10 * 60_000);

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result).toMatchObject({ outcome: 'skipped', skipReason: 'lease-held' });
      expect(bench.runs.docs).toEqual([]);
      expect(bench.catalog.rows).toEqual([]);
    });

    it('is reclaimable once a crashed run lets it expire', async () => {
      await bench.cache.claimDedup(DISCOVERY_LEASE_KEY, { claimedAt: START.toISOString() }, 60_000);
      bench.advance(61_000);

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.outcome).toBe('ok');
    });

    it('is released on a successful terminal outcome', async () => {
      await runModelDiscovery(bench.adapters, bench.options);

      expect(bench.cache.entries.has(DISCOVERY_LEASE_KEY)).toBe(false);
      expect(bench.cache.deleteCalls).toBe(1);
    });

    it('is released when the run throws', async () => {
      bench.catalog.rowsInForceWithRejects = vi.fn().mockRejectedValue(new Error('mongo is down'));

      await expect(runModelDiscovery(bench.adapters, bench.options)).rejects.toThrow('mongo is down');

      expect(bench.cache.entries.has(DISCOVERY_LEASE_KEY)).toBe(false);
    });

    it('sizes the lease at twice the global deadline', async () => {
      await bench.cache.claimDedup(DISCOVERY_LEASE_KEY, {}, 1);
      bench.advance(2);
      const claimed: number[] = [];
      const original = bench.cache.claimDedup.bind(bench.cache);
      bench.cache.claimDedup = async (key, data, ttlMs) => {
        claimed.push(ttlMs);
        return original(key, data, ttlMs);
      };

      await runModelDiscovery(bench.adapters, { ...bench.options, budgetMs: 300_000 });

      expect(claimed).toEqual([2 * (300_000 - 60_000)]);
    });
  });

  describe('absence bookkeeping', () => {
    it('freezes the counters of a backend whose source failed', async () => {
      // Seed the catalog with a model, then fail the only source that lists it.
      await runModelDiscovery(bench.adapters, bench.options);
      bench.advance(60_000);
      const failing = stubSource({ name: 'openai', kind: 'provider', result: { ok: false, error: 'HTTP 503' } });
      bench.adapters.sources = [failing];

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.absence.missed).toEqual([]);
      expect(result.absence.frozenBackends).toEqual([ModelBackend.OpenAI]);
      expect(bench.state.misses).toEqual([]);
    });

    it('counts a miss when the source succeeds and the model is gone', async () => {
      await runModelDiscovery(bench.adapters, bench.options);
      bench.advance(60_000);
      bench.adapters.sources = [openaiSource([])];

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.absence.missed).toEqual(['gpt-6']);
      expect(bench.state.misses).toEqual(['gpt-6']);
      // Bookkeeping only: Phase 2 never transitions a lifecycle from absence.
      expect(bench.catalog.rows).toHaveLength(1);
      expect(result.metrics.ModelsDeprecated).toBe(0);
    });
  });

  describe('pricing', () => {
    /** A row already in force for gpt-6, at the rate and provenance under test. */
    const seedPrice = async (bench: Harness, tier: { input: number; output: number }, note = 'adapter-seed') => {
      await bench.prices.append({
        modelId: 'gpt-6',
        unit: 'per_token',
        pricing: { '0': tier },
        effectiveFrom: new Date(START.getTime() - 60_000),
        note,
      });
    };

    it('appends the price row alongside the catalog row in write mode', async () => {
      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(bench.prices.rows).toHaveLength(1);
      expect(bench.prices.rows[0]).toMatchObject({
        modelId: 'gpt-6',
        unit: 'per_token',
        effectiveFrom: START,
        repricedBy: 'model-discovery',
      });
      // $2/$8 per MTok as the collection stores it: USD per single token.
      expect(bench.prices.rows[0].pricing['0']).toEqual({ input: 2e-6, output: 8e-6 });
      expect(result.metrics.PriceRowsAppended).toBe(1);
      expect(bench.runs.docs[0].changes?.repriced).toEqual(['gpt-6']);
    });

    it('appends no price row on a second run over identical source data', async () => {
      await runModelDiscovery(bench.adapters, bench.options);
      bench.advance(60_000);

      await runModelDiscovery(bench.adapters, bench.options);

      expect(bench.prices.rows).toHaveLength(1);
    });

    it('reports the plan and writes nothing in report mode', async () => {
      const reporting = harness([openaiSource()], { modelDiscoveryMode: 'report' });

      const result = await runModelDiscovery(reporting.adapters, reporting.options);

      expect(reporting.prices.rows).toEqual([]);
      expect(result.metrics.PriceRowsAppended).toBe(0);
      expect(result.prices.rows).toEqual([
        {
          modelId: 'gpt-6',
          unit: 'per_token',
          inputPerMTok: 2,
          outputPerMTok: 8,
          effectiveFrom: START,
          sources: ['openai'],
          note: `discovery:openai@${START.toISOString()}`,
        },
      ]);
    });

    it('flags a move beyond the band under its own log prefix and applies nothing', async () => {
      // $8/MTok in force against the $2 the source reports: a 75% cut, past
      // the 50% default band.
      await seedPrice(bench, { input: 8e-6, output: 8e-6 });

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(bench.prices.rows).toHaveLength(1);
      expect(result.metrics.PriceFlagged).toBe(1);
      expect(result.prices.flags[0]).toMatchObject({ modelId: 'gpt-6', kind: 'band-exceeded' });
      expect(bench.runs.docs[0].changes?.flagged).toEqual(['gpt-6']);
      expect(bench.warnings.some(message => message.startsWith('[PRICE_BAND]'))).toBe(true);
    });

    it('honors a widened band from the admin setting', async () => {
      const wide = harness([openaiSource()], { modelDiscoveryPriceBandPct: 90 });
      await seedPrice(wide, { input: 8e-6, output: 8e-6 });

      const result = await runModelDiscovery(wide.adapters, wide.options);

      expect(result.metrics.PriceFlagged).toBe(0);
      expect(wide.prices.rows).toHaveLength(2);
    });

    it('treats the unique-index collision as a skip, not a failed run', async () => {
      // Same (modelId, unit, effectiveFrom) as the row this run would write,
      // which is what a second driver racing on the same run window produces.
      await bench.prices.append({
        modelId: 'gpt-6',
        unit: 'per_token',
        pricing: { '0': { input: 3e-6, output: 9e-6 } },
        effectiveFrom: START,
        note: 'discovery:openai@2026-07-26T09:00:00.000Z',
      });

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.outcome).toBe('ok');
      expect(result.metrics.PriceRowsAppended).toBe(0);
      expect(bench.prices.rows).toHaveLength(1);
    });

    it('promotes a model whose only trusted price is the row already in force', async () => {
      // No source quotes this model, so hasTrustedPrice can only come from the
      // ModelPrice collection - the wiring that keeps a priced model from
      // being re-blocked as unpriced on a run where nobody quoted it.
      const unquoted = harness([openaiSource([{ ...gpt6, pricing: undefined }])]);
      await seedPrice(unquoted, { input: 2e-6, output: 8e-6 });

      const result = await runModelDiscovery(unquoted.adapters, unquoted.options);

      expect(result.diff[0]).toMatchObject({ modelId: 'gpt-6', promoted: true, blockedBy: [] });
      expect(result.metrics.ModelsPromoted).toBe(1);
    });

    it('never supersedes an operator price row', async () => {
      await seedPrice(bench, { input: 2.5e-6, output: 12e-6 }, 'manual reprice');

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(bench.prices.rows).toHaveLength(1);
      expect(bench.prices.rows[0].note).toBe('manual reprice');
      expect(result.prices.flags[0]).toMatchObject({ kind: 'operator-owned-divergence' });
    });
  });

  it('reports aggregator join coverage and the ids nothing matched', async () => {
    const joined = harness([
      openaiSource([gpt6, { ...gpt6, modelId: 'gpt-6-mini', patch: { ...gpt6.patch, id: 'gpt-6-mini' } }]),
      stubSource({
        name: 'models.dev',
        kind: 'aggregator',
        records: [{ modelId: 'gpt-6', patch: { supportsTools: true } }],
      }),
    ]);

    await runModelDiscovery(joined.adapters, joined.options);
    joined.advance(60_000);
    const second = await runModelDiscovery(joined.adapters, joined.options);

    expect(second.metrics.AggregatorJoinCoverage).toEqual({ 'models.dev': 0.5 });
    expect(joined.runs.docs[1].unmatchedIds).toEqual(['gpt-6-mini']);
  });
});
