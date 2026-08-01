import { ModelBackend, type SettingKey } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeAdminSettingsRepository,
  FakeCacheRepository,
  FakeCatalogRepository,
  FakeDiscoveryStateRepository,
  FakePriceRepository,
  FakeRunRepository,
  fakeCatalogView,
  stubSource,
  testCredentials,
  testRecord,
} from './__fixtures__/fakes';
import {
  DISCOVERY_LEASE_KEY,
  MAX_DISCOVERY_PASSES,
  MAX_PERSISTED_RUN_DETAIL,
  runModelDiscovery,
} from './runModelDiscovery';
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
  errors: string[];
  infos: string[];
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
  const errors: string[] = [];
  const infos: string[] = [];
  const logger: DiscoveryLogger = {
    info: message => infos.push(message),
    warn: message => warnings.push(message),
    error: message => errors.push(message),
  };

  return {
    cache,
    catalog,
    prices,
    state,
    runs,
    warnings,
    errors,
    infos,
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
    // On the document, not inferred from the setting at read time: the plan below
    // it counts rows this run deliberately did not write, and a reader with no
    // mode cannot tell that from a write run whose appends all threw.
    expect(reporting.runs.docs[0]).toMatchObject({ mode: 'report', changes: { plannedPriceRows: 1 } });
    expect(reporting.runs.docs[0].changes?.appendedPriceRows).toBe(0);
  });

  it('records the mode it ran in from the moment the run document exists', async () => {
    // Written at creation rather than at the final update, so a run killed
    // mid-flight still says what it was allowed to do.
    await runModelDiscovery(bench.adapters, bench.options);

    expect(bench.runs.docs[0].mode).toBe('write');
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
    // Nothing failed, so nothing degrades the status; the empty source list and
    // the skip counts in the summary are what say no data was refreshed.
    expect(result.outcome).toBe('ok');
    expect(result.sources).toEqual([]);
    expect(walled.infos.some(message => message.includes('skipped=2(egress-disabled:2)'))).toBe(true);
    expect(walled.catalog.rows).toEqual([]);
  });

  it('skips a source another host fetched successfully within the interval', async () => {
    await runModelDiscovery(bench.adapters, bench.options);
    bench.advance(60_000);

    const result = await runModelDiscovery(bench.adapters, { ...bench.options, minSourceIntervalMs: 30 * 60_000 });

    expect(result.skippedSources).toEqual([{ name: 'openai', reason: 'recently-fetched' }]);
    // A source skipped as fresh is fresh data, not a degraded run.
    expect(result.outcome).toBe('ok');
  });

  it('fetches a recently-fetched source anyway when an operator asks for it', async () => {
    await runModelDiscovery(bench.adapters, bench.options);
    bench.advance(10 * 60_000);

    const result = await runModelDiscovery(bench.adapters, {
      ...bench.options,
      trigger: 'manual',
      minSourceIntervalMs: 60 * 60_000,
    });

    // Run now producing attempts=0 is the button reading as broken exactly when
    // an operator wants a fetch.
    expect(result.skippedSources).toEqual([]);
    expect(result.sources.map(report => report.name)).toEqual(['openai']);
  });

  it('skips a source with no credential without failing the run', async () => {
    const partial = harness([openaiSource(), stubSource({ name: 'xai', configured: false })]);

    const result = await runModelDiscovery(partial.adapters, partial.options);

    expect(result.skippedSources).toEqual([{ name: 'xai', reason: 'not-configured' }]);
    // A structurally unconfigurable source (bedrock under self-host, xai with no
    // key) must not make every run 'partial' forever: lastSuccessfulRun reads
    // status === 'ok', and without one the startup staleness gate never trips.
    expect(result.outcome).toBe('ok');
    expect(partial.runs.docs[0].status).toBe('ok');
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
      // One miss is bookkeeping; the transition waits for K misses over 48h.
      expect(bench.catalog.rows).toHaveLength(1);
      expect(result.metrics.ModelsDeprecated).toBe(0);
    });

    it('still counts a miss while an aggregator lists a model the provider dropped', async () => {
      await runModelDiscovery(bench.adapters, bench.options);
      bench.advance(60_000);
      // litellm and models.dev keep retired ids forever, so an aggregator record
      // must neither reset the streak nor prevent the miss.
      bench.adapters.sources = [
        openaiSource([]),
        stubSource({
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: { supportsTools: true } }],
        }),
      ];

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.absence.missed).toEqual(['gpt-6']);
      expect(result.absence.sighted).toEqual([]);
      expect(bench.state.misses).toEqual(['gpt-6']);
    });

    it('resets the streak the moment the provider lists it again', async () => {
      await runModelDiscovery(bench.adapters, bench.options);
      bench.adapters.sources = [openaiSource([])];
      bench.advance(60_000);
      await runModelDiscovery(bench.adapters, bench.options);
      expect(bench.state.states.get('gpt-6')?.missCount).toBe(1);

      bench.adapters.sources = [openaiSource()];
      bench.advance(60_000);
      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.absence.sighted).toEqual(['gpt-6']);
      expect(bench.state.states.get('gpt-6')?.missCount).toBe(0);
    });
  });

  describe('lifecycle', () => {
    const DAY = 24 * 60 * 60_000;

    /** A seed row for gpt-6, so a report-mode run has a catalog to diff against. */
    const seedGpt6 = (harnessed: Harness) =>
      harnessed.catalog.append({
        modelId: 'gpt-6',
        source: 'seed',
        patch: testRecord({ id: 'gpt-6', name: 'GPT-6', contextWindow: 400_000, lifecycle: { status: 'active' } }),
        ownedGroups: ['identity', 'limits', 'dispatch', 'lifecycle'],
        effectiveFrom: new Date(START.getTime() - DAY),
      });

    /** Seed the catalog with gpt-6, then run again `misses` times without it. */
    const missFor = async (harnessed: Harness, misses: number, gapMs = DAY) => {
      let result = await runModelDiscovery(harnessed.adapters, harnessed.options);
      harnessed.adapters.sources = [openaiSource([])];
      for (let miss = 0; miss < misses; miss += 1) {
        harnessed.advance(gapMs);
        result = await runModelDiscovery(harnessed.adapters, harnessed.options);
      }
      return result;
    };

    describe('absence protocol', () => {
      it('deprecates on the third miss of a streak spanning 48h', async () => {
        const result = await missFor(bench, 3);

        expect(result.lifecycle.transitions).toEqual([
          {
            modelId: 'gpt-6',
            from: 'active',
            to: 'deprecated',
            signal: 'absence',
            deprecationDate: '2026-07-29',
            retirementDate: undefined,
            replacedBy: undefined,
            autoApplied: false,
          },
        ]);
        expect(result.lifecycle.wouldDeprecate).toEqual(['gpt-6']);
        expect(result.metrics.ModelsDeprecated).toBe(1);
        expect(bench.runs.docs[3].changes?.deprecated).toEqual(['gpt-6']);
        // The count says one model moved; only the transition says from what, on
        // what signal, and with which dates.
        expect(bench.runs.docs[3].lifecycleTransitions).toEqual([
          {
            modelId: 'gpt-6',
            from: 'active',
            to: 'deprecated',
            signal: 'absence',
            deprecationDate: '2026-07-29',
            autoApplied: false,
          },
        ]);
        expect(bench.catalog.rows).toHaveLength(2);
        expect(bench.catalog.rows[1].patch).toMatchObject({
          id: 'gpt-6',
          name: 'GPT-6',
          lifecycle: { status: 'deprecated', deprecationDate: '2026-07-29' },
        });
      });

      it('waits while only two misses have accrued', async () => {
        const result = await missFor(bench, 2);

        expect(result.lifecycle.transitions).toEqual([]);
        expect(bench.catalog.rows).toHaveLength(1);
      });

      it('waits while three misses fit inside 48h', async () => {
        const result = await missFor(bench, 3, 6 * 60 * 60_000);

        expect(result.lifecycle.transitions).toEqual([]);
      });

      it('neither increments nor resets the streak on a failed fetch', async () => {
        await runModelDiscovery(bench.adapters, bench.options);
        bench.adapters.sources = [openaiSource([])];
        bench.advance(DAY);
        await runModelDiscovery(bench.adapters, bench.options);

        bench.adapters.sources = [stubSource({ name: 'openai', result: { ok: false, error: 'HTTP 503' } })];
        bench.advance(DAY);
        const frozen = await runModelDiscovery(bench.adapters, bench.options);
        expect(frozen.absence.frozenBackends).toEqual([ModelBackend.OpenAI]);
        expect(bench.state.states.get('gpt-6')?.missCount).toBe(1);

        bench.adapters.sources = [openaiSource([])];
        bench.advance(DAY);
        const third = await runModelDiscovery(bench.adapters, bench.options);
        // Two misses so far: the failed run in the middle bought the provider a
        // free pass rather than a strike.
        expect(third.lifecycle.transitions).toEqual([]);

        bench.advance(DAY);
        const fourth = await runModelDiscovery(bench.adapters, bench.options);
        expect(fourth.lifecycle.transitions).toHaveLength(1);
      });

      it('resets the streak on a sighting', async () => {
        await missFor(bench, 2);
        bench.adapters.sources = [openaiSource()];
        bench.advance(DAY);
        await runModelDiscovery(bench.adapters, bench.options);
        expect(bench.state.states.get('gpt-6')?.missCount).toBe(0);

        bench.adapters.sources = [openaiSource([])];
        bench.advance(DAY);
        const result = await runModelDiscovery(bench.adapters, bench.options);

        expect(result.lifecycle.transitions).toEqual([]);
      });

      it('appends nothing more once the model is deprecated', async () => {
        await missFor(bench, 3);
        bench.advance(DAY);

        const result = await runModelDiscovery(bench.adapters, bench.options);

        expect(result.lifecycle.transitions).toEqual([]);
        expect(bench.catalog.rows).toHaveLength(2);
        // Still counted as missing, which is only possible if the graduation row
        // kept the identity group it took over from the row it superseded.
        expect(result.absence.missed).toEqual(['gpt-6']);
      });

      it('plans the graduation but writes nothing in report mode', async () => {
        // Report mode never applies a miss, so the plan has to reach the same
        // verdict from the counters as they stood when the run started.
        const reporting = harness([openaiSource([])], { modelDiscoveryMode: 'report' });
        await seedGpt6(reporting);
        reporting.state.states.set('gpt-6', {
          modelId: 'gpt-6',
          missCount: 2,
          firstMissAt: new Date(START.getTime() - 72 * 60 * 60_000),
          createdAt: START,
          updatedAt: START,
        });

        const result = await runModelDiscovery(reporting.adapters, reporting.options);

        expect(result.lifecycle.wouldDeprecate).toEqual(['gpt-6']);
        expect(result.lifecycle.transitions[0]).toMatchObject({ from: 'active', to: 'deprecated' });
        expect(reporting.catalog.rows).toHaveLength(1);
        expect(reporting.state.misses).toEqual([]);
      });
    });

    describe('typed and docs signals', () => {
      const sunset = (lifecycle: NonNullable<DiscoveredModel['patch']['lifecycle']>, evidence: 'typed' | 'docs') => ({
        ...gpt6,
        patch: { ...gpt6.patch, lifecycle },
        lifecycleEvidence: evidence,
      });

      /** Seed gpt-6 as active, then report it again with the lifecycle under test. */
      const secondRun = async (harnessed: Harness, sources: DiscoverySource[]) => {
        await runModelDiscovery(harnessed.adapters, harnessed.options);
        harnessed.adapters.sources = sources;
        harnessed.advance(60_000);
        return runModelDiscovery(harnessed.adapters, harnessed.options);
      };

      it('transitions on the first run a typed source reports it', async () => {
        const result = await secondRun(bench, [
          openaiSource([sunset({ status: 'legacy', deprecationDate: '2026-07-30' }, 'typed')]),
        ]);

        expect(result.lifecycle.transitions[0]).toMatchObject({
          modelId: 'gpt-6',
          from: 'active',
          to: 'legacy',
          signal: 'typed',
          deprecationDate: '2026-07-30',
        });
        expect(bench.catalog.rows[1].patch).toMatchObject({ lifecycle: { status: 'legacy' } });
        expect(bench.warnings.some(message => message.startsWith('[model-sunset]'))).toBe(true);
      });

      it('reports and logs a future date a typed source set without a status change', async () => {
        const result = await secondRun(bench, [
          openaiSource([sunset({ status: 'active', deprecationDate: '2026-12-01' }, 'typed')]),
        ]);

        // Not a deprecation this run, but the picker drops the model the day the
        // date passes, so it cannot be invisible until then.
        expect(result.lifecycle.transitions).toEqual([]);
        expect(result.metrics.ModelsDeprecated).toBe(0);
        expect(result.lifecycle.dateChanges).toEqual([
          {
            modelId: 'gpt-6',
            status: 'active',
            signal: 'typed',
            previousDeprecationDate: undefined,
            deprecationDate: '2026-12-01',
            previousRetirementDate: undefined,
            retirementDate: undefined,
          },
        ]);
        expect(bench.warnings.some(message => message.startsWith('[model-sunset]'))).toBe(true);
      });

      it('queues a docs-only deprecation instead of writing it', async () => {
        const result = await secondRun(bench, [
          openaiSource([sunset({ status: 'deprecated', deprecationDate: '2026-07-30' }, 'docs')]),
        ]);

        expect(result.lifecycle.transitions).toEqual([]);
        expect(result.metrics.ModelsDeprecated).toBe(0);
        expect(bench.catalog.rows).toHaveLength(1);
        expect(result.lifecycle.suggestions[0]).toMatchObject({
          modelId: 'gpt-6',
          status: 'deprecated',
          deprecationDate: '2026-07-30',
          source: 'openai',
        });
        expect(bench.state.suggestions[0]).toMatchObject({
          modelId: 'gpt-6',
          suggestion: { status: 'deprecated', source: 'openai' },
        });
      });

      it('records no suggestion in report mode', async () => {
        const docs = sunset({ status: 'deprecated', deprecationDate: '2026-07-30' }, 'docs');
        const reporting = harness([openaiSource([docs])], { modelDiscoveryMode: 'report' });
        await seedGpt6(reporting);

        const result = await runModelDiscovery(reporting.adapters, reporting.options);

        expect(result.lifecycle.suggestions).toHaveLength(1);
        expect(reporting.state.suggestions).toEqual([]);
      });

      it('writes the docs dates once a typed source corroborates the sunset', async () => {
        const result = await secondRun(bench, [
          openaiSource([sunset({ status: 'deprecated', deprecationDate: '2026-07-30' }, 'docs')]),
          stubSource({
            name: 'litellm',
            kind: 'aggregator',
            records: [{ modelId: 'gpt-6', patch: { lifecycle: { status: 'deprecated' } }, lifecycleEvidence: 'typed' }],
          }),
        ]);

        expect(result.lifecycle.transitions[0]).toMatchObject({ to: 'deprecated', deprecationDate: '2026-07-30' });
        expect(bench.catalog.rows[1].patch).toMatchObject({
          lifecycle: { status: 'deprecated', deprecationDate: '2026-07-30' },
        });
      });

      it('drops a docs signal whose parser row count moved more than 20%', async () => {
        const docsSource = (rows: number) =>
          stubSource({
            name: 'openai',
            kind: 'provider',
            result: {
              ok: true,
              records: [sunset({ status: 'deprecated', deprecationDate: '2026-07-30' }, 'docs')],
              authoritativeFor: [ModelBackend.OpenAI],
              parserRows: { deprecations: rows },
            },
          });
        const shifting = harness([docsSource(10)]);

        await runModelDiscovery(shifting.adapters, shifting.options);
        shifting.adapters.sources = [docsSource(4)];
        shifting.advance(60_000);
        const result = await runModelDiscovery(shifting.adapters, shifting.options);

        expect(result.metrics.DocsParserRowShift).toBe(1);
        expect(result.lifecycle.suggestions).toEqual([]);
        expect(shifting.warnings.some(message => message.includes('parser "deprecations"'))).toBe(true);
      });
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
      // $8/MTok in force against the $2 the source reports: a 4x cut, which the
      // band scores as 300%, past the 50% default.
      await seedPrice(bench, { input: 8e-6, output: 8e-6 });

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(bench.prices.rows).toHaveLength(1);
      expect(result.metrics.PriceFlagged).toBe(1);
      expect(result.prices.flags[0]).toMatchObject({ modelId: 'gpt-6', kind: 'band-exceeded' });
      expect(bench.runs.docs[0].changes?.flagged).toEqual(['gpt-6']);
      expect(bench.warnings.some(message => message.startsWith('[PRICE_BAND]'))).toBe(true);
    });

    it('honors a widened band from the admin setting', async () => {
      // The same 4x cut, applied unattended only by a band that admits 4x.
      const wide = harness([openaiSource()], { modelDiscoveryPriceBandPct: 400 });
      await seedPrice(wide, { input: 8e-6, output: 8e-6 });

      const result = await runModelDiscovery(wide.adapters, wide.options);

      expect(result.metrics.PriceFlagged).toBe(0);
      expect(wide.prices.rows).toHaveLength(2);
    });

    it('degrades the run when an append throws instead of reporting the plan as done', async () => {
      // The log-and-continue contract: one row throwing must not abandon the
      // rest, but the run may not then claim 'ok' with a full metric set either.
      const append = bench.prices.append.bind(bench.prices);
      let first = true;
      bench.prices.append = async row => {
        if (!first) return append(row);
        first = false;
        throw new Error('write concern timed out');
      };

      const result = await runModelDiscovery(bench.adapters, bench.options);

      // The convergence pass re-plans the row and it lands, so the catalog does
      // recover - but the run still has to say a write was lost, or a run whose
      // every append threw would be indistinguishable from a clean one.
      expect(result.outcome).toBe('partial');
      expect(bench.errors.some(message => message.includes('lost 1 write'))).toBe(true);
      const changes = bench.runs.docs[0].changes;
      expect(changes?.appendedPriceRows).toBeLessThan(changes?.plannedPriceRows ?? 0);
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

      // The collision is a skip: it neither throws nor fails the run. It costs
      // pass 1 its price row, and the convergence pass re-plans the row against
      // what is now in force and stamps it a millisecond later, which the
      // unique index accepts - the same row the next run would have written.
      expect(result.outcome).toBe('ok');
      expect(result.metrics.PriceRowsAppended).toBe(1);
      expect(bench.prices.rows).toHaveLength(2);
      expect(bench.prices.rows[1].effectiveFrom).toEqual(new Date(START.getTime() + 1));
      expect(bench.prices.rows[1].pricing['0']).toEqual({ input: 2e-6, output: 8e-6 });
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

  describe('convergence', () => {
    /** Only the provider lists it, so an aggregator can join it only once it is written. */
    const gpt7: DiscoveredModel = {
      modelId: 'gpt-7',
      patch: {
        id: 'gpt-7',
        vendor: 'openai',
        backend: ModelBackend.OpenAI,
        type: 'text',
        name: 'GPT-7',
        contextWindow: 500_000,
      },
    };

    /**
     * A provider plus two aggregators that read their join targets on every
     * fetch, through the same memoized view the drivers hand the real ones.
     */
    const convergent = (
      records: DiscoveredModel[],
      enrich: (modelId: string) => DiscoveredModel,
      settings: Partial<Record<SettingKey, unknown>> = {}
    ) => {
      const bench = harness([], settings);
      const view = fakeCatalogView(bench.catalog);
      let fetches = 0;
      const aggregator = (name: string) =>
        stubSource({
          name,
          kind: 'aggregator',
          onFetch: () => {
            fetches += 1;
          },
          records: async () => (await view.targets()).map(enrich),
        });
      bench.adapters.sources = [openaiSource(records), aggregator('models.dev'), aggregator('litellm')];
      bench.adapters.refreshCatalogView = view.refresh;
      return { bench, view, aggregatorFetches: () => fetches };
    };

    /** Both aggregators quote the same price, which is what makes it trusted. */
    const enriched = (modelId: string): DiscoveredModel => ({
      modelId,
      patch: { supportsTools: true },
      pricing: { inputPerMTok: 3, outputPerMTok: 9 },
    });

    it('adds, enriches and prices a new model inside one run', async () => {
      const { bench, view } = convergent([gpt7], enriched);

      const result = await runModelDiscovery(bench.adapters, bench.options);

      // Pass 1 can only write the identity the provider reported: the tools
      // flag, the price and the promotion all wait on the join it enables.
      expect(result.passes).toBeGreaterThanOrEqual(2);
      expect(view.reads()).toBe(result.passes);
      expect(bench.catalog.rows).toHaveLength(2);
      expect(bench.catalog.rows[1].patch).toMatchObject({ supportsTools: true, lifecycle: { status: 'active' } });
      expect(bench.prices.rows).toHaveLength(1);
      expect(bench.prices.rows[0].pricing['0']).toEqual({ input: 3e-6, output: 9e-6 });
      expect(result.metrics).toMatchObject({ ModelsDiscovered: 1, ModelsPromoted: 1, PriceRowsAppended: 1 });

      // A run over the settled catalog has nothing left to converge on. The
      // refresh stands in for the next run's fresh adapters object.
      view.refresh();
      bench.advance(60_000);
      const second = await runModelDiscovery(bench.adapters, bench.options);

      expect(second.passes).toBe(1);
      expect(second.diff).toEqual([]);
      expect(bench.catalog.rows).toHaveLength(2);
      expect(bench.prices.rows).toHaveLength(1);
    });

    it('applies a sunset the re-join reported rather than promoting the model first', async () => {
      const { bench } = convergent([gpt7], modelId => ({
        modelId,
        patch: { lifecycle: { status: 'deprecated', deprecationDate: '2026-01-15' } },
        pricing: { inputPerMTok: 3, outputPerMTok: 9 },
        lifecycleEvidence: 'typed',
      }));

      const result = await runModelDiscovery(bench.adapters, bench.options);

      // The trusted price lands in the same pass as the sunset. Promoting on it
      // would overwrite the declared status and cost the transition a whole run.
      expect(result.lifecycle.transitions).toEqual([
        {
          modelId: 'gpt-7',
          from: 'discovered',
          to: 'deprecated',
          signal: 'typed',
          deprecationDate: '2026-01-15',
          retirementDate: undefined,
          replacedBy: undefined,
          autoApplied: false,
        },
      ]);
      expect(result.metrics.ModelsDeprecated).toBe(1);
      expect(result.diff.some(entry => entry.promoted)).toBe(false);
      expect(bench.catalog.rows[bench.catalog.rows.length - 1].patch).toMatchObject({
        lifecycle: { status: 'deprecated', deprecationDate: '2026-01-15' },
      });
    });

    it('stops at the pass cap when a source disagrees with itself on every fetch', async () => {
      const bench = harness([]);
      const view = fakeCatalogView(bench.catalog);
      // Two aggregators drifting in lockstep: they always agree with each other,
      // so the price is trusted, and never with the row the last pass wrote.
      const drifting = (name: string) => {
        let quote = 2;
        return stubSource({
          name,
          kind: 'aggregator',
          records: async () => {
            quote += 0.02;
            const targets = await view.targets();
            return targets.map(modelId => ({
              modelId,
              patch: {},
              pricing: { inputPerMTok: quote, outputPerMTok: 8 },
            }));
          },
        });
      };
      bench.adapters.sources = [
        openaiSource([{ ...gpt6, pricing: undefined }]),
        drifting('models.dev'),
        drifting('litellm'),
      ];
      bench.adapters.refreshCatalogView = view.refresh;

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.passes).toBe(MAX_DISCOVERY_PASSES);
      expect(result.outcome).toBe('ok');
      expect(bench.warnings.some(message => message.includes('convergence capped'))).toBe(true);
      // Every pass after the first repriced the model the next one disagreed with.
      expect(bench.prices.rows).toHaveLength(MAX_DISCOVERY_PASSES - 1);
    });

    it('bands every pass against the price in force when the run started', async () => {
      // Two aggregators drifting 40% per fetch, in lockstep so their price is
      // trusted. 40% clears the 50% band once; the second pass is another 40% on
      // top, which is 96% against where the run began.
      const quoting = (name: string) => {
        let quote = 1;
        return stubSource({
          name,
          kind: 'aggregator',
          records: () => {
            quote *= 1.4;
            return [{ modelId: 'gpt-6', patch: {}, pricing: { inputPerMTok: quote, outputPerMTok: quote } }];
          },
        });
      };
      const drifting = harness([
        openaiSource([{ ...gpt6, pricing: undefined }]),
        quoting('models.dev'),
        quoting('litellm'),
      ]);
      await drifting.prices.append({
        modelId: 'gpt-6',
        unit: 'per_token',
        pricing: { '0': { input: 1e-6, output: 1e-6 } },
        effectiveFrom: new Date(START.getTime() - 60_000),
        note: 'adapter-seed',
      });

      const result = await runModelDiscovery(drifting.adapters, drifting.options);

      // Re-measuring each pass against the row the pass before it wrote would
      // apply the whole 1.96x unattended, one band at a time.
      expect(result.passes).toBe(2);
      expect(drifting.prices.rows).toHaveLength(2);
      expect(drifting.prices.rows[1].pricing['0'].input).toBe(1.4 / 1_000_000);
      expect(result.prices.flags).toHaveLength(1);
      expect(result.prices.flags[0]).toMatchObject({ modelId: 'gpt-6', kind: 'band-exceeded' });
    });

    it('keeps a source that succeeded in pass 1 when its refetch fails', async () => {
      let fetches = 0;
      const flakyAggregator: DiscoverySource = {
        name: 'models.dev',
        kind: 'aggregator',
        isConfigured: () => true,
        fetch: async () => {
          fetches += 1;
          return fetches === 1
            ? { ok: true, records: [{ modelId: 'gpt-7', patch: { supportsTools: true } }] }
            : { ok: false, error: 'HTTP 502' };
        },
      };
      const flaky = harness([openaiSource([gpt7]), flakyAggregator]);

      const result = await runModelDiscovery(flaky.adapters, flaky.options);

      // Pass 1's records were committed; reporting the source as failed for the
      // run would alarm on data the run actually used.
      expect(fetches).toBeGreaterThan(1);
      expect(result.sources.find(report => report.name === 'models.dev')).toMatchObject({ ok: true });
      expect(result.metrics.SourceFailures).toEqual({ openai: 0, 'models.dev': 0 });
      expect(result.outcome).toBe('ok');
      expect(flaky.warnings.some(message => message.includes('refetch failed'))).toBe(true);
    });

    it('makes one pass and fetches each source once in report mode', async () => {
      const { bench, aggregatorFetches } = convergent([gpt7], enriched, { modelDiscoveryMode: 'report' });

      const result = await runModelDiscovery(bench.adapters, bench.options);

      expect(result.passes).toBe(1);
      // Two aggregators, one fetch each: an extra pass would re-download both
      // feeds for a diff report mode is never going to apply.
      expect(aggregatorFetches()).toBe(2);
      expect(bench.catalog.rows).toEqual([]);
      expect(bench.prices.rows).toEqual([]);
      expect(result.diff).toHaveLength(1);
    });

    it('never re-fetches an aggregator the interval guard skipped', async () => {
      const bench = harness([]);
      let fetches = 0;
      // A successful models.dev fetch a minute ago, on any host: the guard reads
      // the run history rather than this process.
      await bench.runs.create({
        startedAt: new Date(START.getTime() - 60_000),
        trigger: 'cron',
        host: 'hosted',
        status: 'ok',
        sources: [{ name: 'models.dev', ok: true, durationMs: 12 }],
      } as Parameters<FakeRunRepository['create']>[0]);
      bench.adapters.sources = [
        openaiSource([gpt7]),
        stubSource({
          name: 'models.dev',
          kind: 'aggregator',
          onFetch: () => {
            fetches += 1;
          },
        }),
      ];

      const result = await runModelDiscovery(bench.adapters, { ...bench.options, minSourceIntervalMs: 30 * 60_000 });

      expect(result.skippedSources).toEqual([{ name: 'models.dev', reason: 'recently-fetched' }]);
      // Pass 1 appended, so a second pass ran - and re-fetched nothing.
      expect(result.passes).toBe(2);
      expect(fetches).toBe(0);
    });

    it('runs no further pass once the global deadline has fired', async () => {
      const hung = harness([openaiSource([gpt7]), stubSource({ name: 'models.dev', kind: 'aggregator', hang: true })]);

      const result = await runModelDiscovery(hung.adapters, { ...hung.options, budgetMs: 1_000 });

      // The catalog row pass 1 wrote is exactly what would have made pass 2 due.
      expect(hung.catalog.rows).toHaveLength(1);
      expect(result.passes).toBe(1);
      expect(result.outcome).toBe('partial');
    });
  });

  describe('the persisted run report', () => {
    const gpt6mini: DiscoveredModel = {
      ...gpt6,
      modelId: 'gpt-6-mini',
      patch: { ...gpt6.patch, id: 'gpt-6-mini', name: 'GPT-6 mini' },
    };

    /** An operator row for the model, which is what makes the run report a conflict. */
    const pinByOperator = (harnessed: Harness, modelId: string) =>
      harnessed.catalog.append({
        modelId,
        source: 'operator',
        patch: { rank: 5 },
        ownedGroups: ['presentation'],
        note: 'pinned by an operator',
        effectiveFrom: new Date(START.getTime() - 60_000),
      });

    it('carries the sentence behind each price flag, and the operator overlaps apart from them', async () => {
      const reported = harness([openaiSource([gpt6, gpt6mini])]);
      await pinByOperator(reported, 'gpt-6-mini');
      // $8/MTok in force against the $2 the source reports: past the 50% band.
      await reported.prices.append({
        modelId: 'gpt-6',
        unit: 'per_token',
        pricing: { '0': { input: 8e-6, output: 8e-6 } },
        effectiveFrom: new Date(START.getTime() - 60_000),
        note: 'adapter-seed',
      });

      const result = await runModelDiscovery(reported.adapters, reported.options);
      const persisted = reported.runs.docs[0];

      expect(persisted.priceFlags).toHaveLength(1);
      expect(persisted.priceFlags?.[0]).toMatchObject({
        modelId: 'gpt-6',
        kind: 'band-exceeded',
        proposed: { inputPerMTok: 2, outputPerMTok: 8 },
        current: { inputPerMTok: 8, outputPerMTok: 8 },
        sources: ['openai'],
      });
      // The explanation is what the flags are persisted for: it used to reach
      // logger.warn and nowhere else, leaving "1 flagged" unanswerable.
      expect(persisted.priceFlags?.[0].detail).toBe(result.prices.flags[0].detail);
      expect(persisted.priceFlags?.[0].detail).toContain('band 50%');
      // One queue for the operator, but the merged array cannot say which half of
      // it a model came from.
      expect(persisted.changes?.flagged).toEqual(['gpt-6-mini', 'gpt-6']);
      expect(persisted.changes?.operatorConflicts).toEqual(['gpt-6-mini']);
      expect(persisted.catalogDiff?.find(entry => entry.modelId === 'gpt-6-mini')).toMatchObject({
        kind: 'added',
        operatorOwned: true,
      });
      // A planned row keeps its Date across the boundary; the schema stores a date.
      expect(persisted.priceRows).toHaveLength(1);
      expect(persisted.priceRows?.[0]).toMatchObject({
        modelId: 'gpt-6-mini',
        unit: 'per_token',
        inputPerMTok: 2,
        outputPerMTok: 8,
        sources: ['openai'],
      });
      expect(persisted.priceRows?.[0].effectiveFrom).toEqual(START);
    });

    it('records the skips a rerun produces in place of a row', async () => {
      await runModelDiscovery(bench.adapters, bench.options);
      bench.advance(60_000);

      await runModelDiscovery(bench.adapters, bench.options);

      // A run that planned no price row reads exactly like a run that saw no
      // price at all until the skip says which model and why.
      expect(bench.runs.docs[1].priceRows).toEqual([]);
      expect(bench.runs.docs[1].priceSkips).toEqual([{ modelId: 'gpt-6', reason: 'unchanged' }]);
    });

    it('bounds every detail array, so one wide run cannot grow the document without limit', async () => {
      const overflow = MAX_PERSISTED_RUN_DETAIL + 50;
      const many: DiscoveredModel[] = Array.from({ length: overflow }, (_unused, index) => ({
        ...gpt6,
        modelId: `gpt-6-${index}`,
        patch: { ...gpt6.patch, id: `gpt-6-${index}`, name: `GPT-6 ${index}` },
      }));
      const wide = harness([openaiSource(many)]);

      const result = await runModelDiscovery(wide.adapters, wide.options);
      const persisted = wide.runs.docs[0];

      // The result is the caller's, unbounded; the document the admin reads whole
      // is not.
      expect(result.diff).toHaveLength(overflow);
      expect(result.prices.rows).toHaveLength(overflow);
      expect(persisted.catalogDiff).toHaveLength(MAX_PERSISTED_RUN_DETAIL);
      expect(persisted.priceRows).toHaveLength(MAX_PERSISTED_RUN_DETAIL);
      // The convergence pass re-read the prices it wrote and skipped every one.
      expect(persisted.priceSkips).toHaveLength(MAX_PERSISTED_RUN_DETAIL);
      // What each slice was cut from. The `changes` ids are uncapped, so without
      // these the report shows 250 flagged in the header and 200 in the section.
      expect(persisted.detailTotals).toEqual({
        catalogDiff: overflow,
        priceRows: overflow,
        priceSkips: overflow,
      });
      // Only the truncated arrays: an untouched one would report a total equal to
      // what is stored, which says nothing.
      expect(persisted.detailTotals?.priceFlags).toBeUndefined();
    });

    it('leaves the totals off entirely when every detail array fit', async () => {
      await runModelDiscovery(bench.adapters, bench.options);

      expect(bench.runs.docs[0].detailTotals).toBeUndefined();
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
