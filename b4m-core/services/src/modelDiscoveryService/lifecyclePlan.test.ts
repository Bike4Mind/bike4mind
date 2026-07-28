import { ModelBackend, type IModelDiscoveryState, type ModelRecord } from '@bike4mind/common';
import type { ResolvedCatalogRecord } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import { testCredentials, testRecord } from './__fixtures__/fakes';
import { planCatalogWrites, type CatalogWritePlan } from './catalogWrite';
import {
  ABSENCE_NOTE_PREFIX,
  detectParserRowShifts,
  planLifecycle,
  planLifecycleSignals,
  type LifecyclePlanInput,
} from './lifecyclePlan';
import type { DiscoveredModel, PerTokenRates, SourceContribution } from './types';

const RUN_AT = new Date('2026-07-26T10:00:00Z');
const HOUR = 60 * 60_000;

const resolved = (record: Partial<ModelRecord> & { id: string }): [string, ResolvedCatalogRecord] => [
  record.id,
  { modelId: record.id, record: record as Record<string, unknown>, ownedGroups: ['identity', 'lifecycle'] },
];

/** An active catalog model on the OpenAI backend, priced unless a test says otherwise. */
const active = (id: string, overrides: Partial<ModelRecord> = {}) =>
  resolved({ ...testRecord({ id, name: id }), lifecycle: { status: 'active' }, ...overrides });

const emptyPlan = (): CatalogWritePlan => ({ diff: [], rows: [], dropped: [], sightedModelIds: new Set() });

const rates = (entries: Record<string, [number, number]>): Map<string, PerTokenRates> =>
  new Map(Object.entries(entries).map(([modelId, [input, output]]) => [modelId, { input, output }]));

const state = (overrides: Partial<IModelDiscoveryState> & { modelId: string }): IModelDiscoveryState => ({
  missCount: 0,
  createdAt: RUN_AT,
  updatedAt: RUN_AT,
  ...overrides,
});

const plan = (overrides: Partial<LifecyclePlanInput> = {}) =>
  planLifecycle({
    catalogPlan: emptyPlan(),
    base: new Map(),
    docs: new Map(),
    missed: [],
    statesBeforeRun: new Map(),
    ratesInForce: new Map(),
    autoRemap: 'suggest',
    operatorOwnedModelIds: new Set(),
    runStartedAt: RUN_AT,
    runId: 'run-1',
    ...overrides,
  });

/** The catalog plan a run would produce from these source records. */
const catalogPlan = (contributions: SourceContribution[], base: Map<string, ResolvedCatalogRecord>) =>
  planCatalogWrites({
    contributions,
    base,
    coveredBackends: new Set<string>([ModelBackend.OpenAI]),
    operatorOwnedModelIds: new Set(),
    credentials: testCredentials(),
    policy: 'priced',
    runStartedAt: RUN_AT,
    runId: 'run-1',
  });

const provider = (name: string, records: DiscoveredModel[]): SourceContribution => ({
  name,
  kind: 'provider',
  records,
});

const aggregator = (name: string, records: DiscoveredModel[]): SourceContribution => ({
  name,
  kind: 'aggregator',
  records,
});

describe('planLifecycleSignals', () => {
  const deprecated = (evidence?: 'typed' | 'docs'): DiscoveredModel => ({
    modelId: 'gpt-5',
    patch: { lifecycle: { status: 'deprecated', deprecationDate: '2026-08-10', replacedBy: 'gpt-6' } },
    ...(evidence ? { lifecycleEvidence: evidence } : {}),
  });

  it('keeps a typed lifecycle in the overlay', () => {
    const signals = planLifecycleSignals({ contributions: [provider('bedrock', [deprecated('typed')])] });

    expect(signals.contributions[0].records[0].patch.lifecycle).toMatchObject({ status: 'deprecated' });
    expect(signals.docs.size).toBe(0);
  });

  it('withholds an uncorroborated docs lifecycle from the overlay', () => {
    const signals = planLifecycleSignals({ contributions: [provider('anthropic', [deprecated('docs')])] });

    expect(signals.contributions[0].records[0].patch).not.toHaveProperty('lifecycle');
    expect(signals.docs.get('gpt-5')).toMatchObject({ source: 'anthropic', corroborated: false });
  });

  it('treats an unmarked lifecycle as docs-tier', () => {
    const signals = planLifecycleSignals({ contributions: [provider('anthropic', [deprecated()])] });

    expect(signals.contributions[0].records[0].patch).not.toHaveProperty('lifecycle');
  });

  it('lets a corroborated docs lifecycle through without its replacedBy', () => {
    const signals = planLifecycleSignals({
      contributions: [
        provider('anthropic', [deprecated('docs')]),
        aggregator('litellm', [
          { modelId: 'gpt-5', patch: { lifecycle: { status: 'deprecated' } }, lifecycleEvidence: 'typed' },
        ]),
      ],
    });

    const anthropic = signals.contributions.find(contribution => contribution.name === 'anthropic');
    // The dates are what docs corroboration is for; replacedBy stays behind the remap gate.
    expect(anthropic?.records[0].patch.lifecycle).toEqual({ status: 'deprecated', deprecationDate: '2026-08-10' });
    expect(signals.docs.get('gpt-5')?.corroborated).toBe(true);
  });

  it('does not treat a typed active status as corroboration', () => {
    const signals = planLifecycleSignals({
      contributions: [
        provider('anthropic', [deprecated('docs')]),
        aggregator('litellm', [
          { modelId: 'gpt-5', patch: { lifecycle: { status: 'active' } }, lifecycleEvidence: 'typed' },
        ]),
      ],
    });

    const anthropic = signals.contributions.find(contribution => contribution.name === 'anthropic');
    expect(anthropic?.records[0].patch).not.toHaveProperty('lifecycle');
  });

  it('drops every docs signal of a source whose parser shifted, suggestions included', () => {
    const signals = planLifecycleSignals({
      contributions: [provider('anthropic', [deprecated('docs')])],
      droppedDocsSources: new Set(['anthropic']),
    });

    expect(signals.contributions[0].records[0].patch).not.toHaveProperty('lifecycle');
    expect(signals.docs.size).toBe(0);
  });

  it('leaves records with no lifecycle untouched', () => {
    const record: DiscoveredModel = { modelId: 'gpt-6', patch: { contextWindow: 400_000 } };
    const signals = planLifecycleSignals({ contributions: [provider('openai', [record])] });

    expect(signals.contributions[0].records[0]).toBe(record);
  });
});

describe('detectParserRowShifts', () => {
  it('flags a move past the tolerance in either direction', () => {
    const shifts = detectParserRowShifts(
      new Map([['anthropic', { deprecations: 4, pricing: 30 }]]),
      new Map([['anthropic', { deprecations: 10, pricing: 28 }]])
    );

    expect(shifts).toEqual([{ source: 'anthropic', parser: 'deprecations', previous: 10, current: 4 }]);
  });

  it('compares nothing without a previous count', () => {
    expect(detectParserRowShifts(new Map([['anthropic', { deprecations: 4 }]]), new Map())).toEqual([]);
    expect(
      detectParserRowShifts(new Map([['anthropic', { pricing: 4 }]]), new Map([['anthropic', { deprecations: 10 }]]))
    ).toEqual([]);
  });
});

describe('planLifecycle absence graduation', () => {
  const base = new Map([active('gpt-5')]);
  const twoDaysAgo = new Date(RUN_AT.getTime() - 48 * HOUR);

  it('does not transition on the second miss', () => {
    const result = plan({
      base,
      missed: ['gpt-5'],
      statesBeforeRun: new Map([['gpt-5', state({ modelId: 'gpt-5', missCount: 1, firstMissAt: twoDaysAgo })]]),
    });

    expect(result.transitions).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('deprecates on the third miss once the streak spans 48h', () => {
    const result = plan({
      base,
      missed: ['gpt-5'],
      statesBeforeRun: new Map([['gpt-5', state({ modelId: 'gpt-5', missCount: 2, firstMissAt: twoDaysAgo })]]),
    });

    expect(result.transitions).toEqual([
      {
        modelId: 'gpt-5',
        from: 'active',
        to: 'deprecated',
        signal: 'absence',
        deprecationDate: '2026-07-26',
        retirementDate: undefined,
        replacedBy: undefined,
        autoApplied: false,
      },
    ]);
    expect(result.wouldDeprecate).toEqual(['gpt-5']);
    expect(result.rows[0]).toMatchObject({
      modelId: 'gpt-5',
      source: 'discovery',
      ownedGroups: ['lifecycle'],
      note: `${ABSENCE_NOTE_PREFIX}${RUN_AT.toISOString()}`,
      runId: 'run-1',
    });
    expect(result.rows[0].patch).toMatchObject({ lifecycle: { status: 'deprecated', deprecationDate: '2026-07-26' } });
    expect(result.diff[0]).toMatchObject({ modelId: 'gpt-5', kind: 'updated', changedKeys: ['lifecycle'] });
  });

  it('folds the graduation into a catalog row the same run already planned', () => {
    // The reachable shape: an aggregator still lists a model the provider
    // dropped, so the same model has a catalog row AND an absence graduation.
    // Two rows would carry the same (modelId, effectiveFrom) and the unique
    // index would drop the second one silently, losing the deprecation while
    // the report insisted it landed.
    const catalog = catalogPlan(
      [aggregator('models.dev', [{ modelId: 'gpt-5', patch: { maxOutputTokens: 64_000 } }])],
      base
    );
    const result = plan({
      base,
      catalogPlan: catalog,
      missed: ['gpt-5'],
      statesBeforeRun: new Map([['gpt-5', state({ modelId: 'gpt-5', missCount: 2, firstMissAt: twoDaysAgo })]]),
    });

    expect(catalog.rows).toHaveLength(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].ownedGroups).toContain('lifecycle');
    expect(result.rows[0].patch.lifecycle).toMatchObject({ status: 'deprecated', deprecationDate: '2026-07-26' });
    expect(result.rows[0].note).toContain(ABSENCE_NOTE_PREFIX);
    expect(result.diff).toHaveLength(1);
    expect(result.diff[0].changedKeys).toContain('lifecycle');
  });

  it('waits when three misses are packed into less than 48h', () => {
    const result = plan({
      base,
      missed: ['gpt-5'],
      statesBeforeRun: new Map([
        ['gpt-5', state({ modelId: 'gpt-5', missCount: 2, firstMissAt: new Date(RUN_AT.getTime() - 47 * HOUR) })],
      ]),
    });

    expect(result.transitions).toEqual([]);
  });

  it('counts this run as the first miss when there is no state row at all', () => {
    const result = plan({ base, missed: ['gpt-5'] });

    expect(result.transitions).toEqual([]);
  });

  it('does not re-append for a model already deprecated', () => {
    const result = plan({
      base: new Map([active('gpt-5', { lifecycle: { status: 'deprecated', deprecationDate: '2026-01-01' } })]),
      missed: ['gpt-5'],
      statesBeforeRun: new Map([['gpt-5', state({ modelId: 'gpt-5', missCount: 9, firstMissAt: twoDaysAgo })]]),
    });

    expect(result.rows).toEqual([]);
    expect(result.transitions).toEqual([]);
  });

  it('graduates nothing for a model the catalog does not hold', () => {
    const result = plan({
      missed: ['ghost'],
      statesBeforeRun: new Map([['ghost', state({ modelId: 'ghost', missCount: 5, firstMissAt: twoDaysAgo })]]),
    });

    expect(result.transitions).toEqual([]);
  });

  it('drops rather than writes a graduation whose record cannot satisfy the append schema', () => {
    const result = plan({
      base: new Map([resolved({ id: 'gpt-5', lifecycle: { status: 'active' } })]),
      missed: ['gpt-5'],
      statesBeforeRun: new Map([['gpt-5', state({ modelId: 'gpt-5', missCount: 2, firstMissAt: twoDaysAgo })]]),
    });

    expect(result.rows).toEqual([]);
    expect(result.dropped[0]).toMatchObject({ source: 'absence', modelId: 'gpt-5' });
  });
});

describe('planLifecycle typed transitions', () => {
  const base = new Map([active('gpt-5')]);

  const typedRun = (patch: ModelRecord['lifecycle'], overrides: Partial<LifecyclePlanInput> = {}) => {
    const view = overrides.base ?? base;
    const signals = planLifecycleSignals({
      contributions: [
        provider('openai', [{ modelId: 'gpt-5', patch: { lifecycle: patch }, lifecycleEvidence: 'typed' }]),
      ],
    });
    return plan({
      ...overrides,
      catalogPlan: catalogPlan(signals.contributions, view),
      base: view,
      docs: signals.docs,
    });
  };

  it('transitions on the first run a typed source reports a sunset', () => {
    const result = typedRun({ status: 'legacy', deprecationDate: '2026-07-30', retirementDate: '2027-01-01' });

    expect(result.transitions[0]).toMatchObject({
      modelId: 'gpt-5',
      from: 'active',
      to: 'legacy',
      signal: 'typed',
      deprecationDate: '2026-07-30',
      retirementDate: '2027-01-01',
    });
  });

  it('reports nothing when the status the source reports is the one in force', () => {
    const result = typedRun({ status: 'active' });

    expect(result.transitions).toEqual([]);
  });

  it('computes no successor for a legacy transition, which still serves traffic', () => {
    const result = typedRun(
      { status: 'legacy' },
      { base: new Map([active('gpt-5'), active('gpt-6')]), ratesInForce: rates({ 'gpt-5': [2, 8], 'gpt-6': [1, 4] }) }
    );

    expect(result.suggestions).toEqual([]);
  });

  it('reports a future date a typed source set without moving the status', () => {
    // A catalog deprecationDate hides the model the day it passes, so this is a
    // sunset in slow motion, not a no-op run.
    const result = typedRun({ status: 'active', deprecationDate: '2026-12-01', retirementDate: '2027-06-01' });

    expect(result.transitions).toEqual([]);
    expect(result.dateChanges).toEqual([
      {
        modelId: 'gpt-5',
        status: 'active',
        signal: 'typed',
        previousDeprecationDate: undefined,
        deprecationDate: '2026-12-01',
        previousRetirementDate: undefined,
        retirementDate: '2027-06-01',
      },
    ]);
  });

  it('reports nothing when the dates the source publishes are the ones in force', () => {
    const held = new Map([active('gpt-5', { lifecycle: { status: 'active', deprecationDate: '2026-12-01' } })]);
    const result = typedRun({ status: 'active', deprecationDate: '2026-12-01' }, { base: held });

    expect(result.dateChanges).toEqual([]);
  });

  it('credits the heuristic for a typed sunset it computed a successor for', () => {
    const base = new Map([active('gpt-5'), active('gpt-6')]);
    const result = typedRun(
      { status: 'deprecated' },
      { base, ratesInForce: rates({ 'gpt-5': [2e-6, 8e-6], 'gpt-6': [1e-6, 4e-6] }) }
    );

    expect(result.suggestions[0]).toMatchObject({ modelId: 'gpt-5', replacedBy: 'gpt-6', source: 'heuristic' });
  });
});

describe('planLifecycle docs suggestions', () => {
  const docsRun = (base: Map<string, ResolvedCatalogRecord>, lifecycle: NonNullable<ModelRecord['lifecycle']>) => {
    const signals = planLifecycleSignals({
      contributions: [provider('anthropic', [{ modelId: 'gpt-5', patch: { lifecycle }, lifecycleEvidence: 'docs' }])],
    });
    return plan({ catalogPlan: catalogPlan(signals.contributions, base), base, docs: signals.docs });
  };

  it('queues an uncorroborated docs deprecation instead of writing it', () => {
    const result = docsRun(new Map([active('gpt-5')]), {
      status: 'deprecated',
      deprecationDate: '2026-08-10',
      retirementDate: '2027-01-01',
    });

    expect(result.transitions).toEqual([]);
    expect(result.rows.some(row => row.source === 'discovery' && row.patch.lifecycle)).toBe(false);
    expect(result.suggestions[0]).toMatchObject({
      modelId: 'gpt-5',
      status: 'deprecated',
      deprecationDate: '2026-08-10',
      retirementDate: '2027-01-01',
      source: 'anthropic',
    });
    expect(result.suggestions[0].detail).toContain('no typed feed corroborates it');
  });

  it('stops re-queueing once the catalog says the same thing', () => {
    const result = docsRun(
      new Map([active('gpt-5', { lifecycle: { status: 'deprecated', deprecationDate: '2026-08-10' } })]),
      { status: 'deprecated', deprecationDate: '2026-08-10' }
    );

    expect(result.suggestions).toEqual([]);
  });

  it('stops re-queueing once an OPERATOR row says the same thing', () => {
    const signals = planLifecycleSignals({
      contributions: [
        provider('anthropic', [
          { modelId: 'gpt-5', patch: { lifecycle: { status: 'deprecated' } }, lifecycleEvidence: 'docs' },
        ]),
      ],
    });
    const base = new Map([active('gpt-5')]);

    const result = plan({
      catalogPlan: catalogPlan(signals.contributions, base),
      base,
      // The operator settled this exact item; the discovery tier still says active.
      resolvedInForce: new Map([active('gpt-5', { lifecycle: { status: 'deprecated' } })]),
      docs: signals.docs,
    });

    expect(result.suggestions).toEqual([]);
  });

  it('queues a docs legacy row rather than dropping it', () => {
    const result = docsRun(new Map([active('gpt-5')]), { status: 'legacy', retirementDate: '2027-01-01' });

    expect(result.transitions).toEqual([]);
    expect(result.suggestions[0]).toMatchObject({ modelId: 'gpt-5', status: 'legacy', source: 'anthropic' });
  });
});

describe('planLifecycle replacedBy', () => {
  /** gpt-5 sunsets by absence, with gpt-6 as the only sibling that could replace it. */
  const sunset = (base: Map<string, ResolvedCatalogRecord>, overrides: Partial<LifecyclePlanInput> = {}) =>
    plan({
      base,
      missed: ['gpt-5'],
      statesBeforeRun: new Map([
        ['gpt-5', state({ modelId: 'gpt-5', missCount: 2, firstMissAt: new Date(RUN_AT.getTime() - 48 * HOUR) })],
      ]),
      ratesInForce: rates({ 'gpt-5': [2e-6, 8e-6], 'gpt-6': [1e-6, 4e-6] }),
      ...overrides,
    });

  const withSuccessor = (overrides: Partial<ModelRecord> = {}) =>
    new Map([active('gpt-5'), active('gpt-6', overrides)]);

  it('picks the family sibling and keeps it as a suggestion under the default policy', () => {
    const result = sunset(withSuccessor());

    expect(result.transitions[0]).toMatchObject({ replacedBy: undefined, autoApplied: false });
    // The K-miss protocol raised this item, so that is what the queue credits;
    // the detail line says the successor came from the family heuristic.
    expect(result.suggestions[0]).toMatchObject({ modelId: 'gpt-5', replacedBy: 'gpt-6', source: 'absence' });
    expect(result.suggestions[0].detail).toContain('the family heuristic picks');
    expect(result.rows[0].patch).not.toHaveProperty('lifecycle.replacedBy');
  });

  it('keeps a candidate an operator row deprecated out of the pool, whatever the discovery tier says', () => {
    const result = sunset(withSuccessor(), {
      autoRemap: 'apply',
      // The discovery-tier view still has gpt-6 active; the operator has spoken.
      resolvedInForce: new Map([active('gpt-5'), active('gpt-6', { lifecycle: { status: 'deprecated' } })]),
    });

    expect(result.transitions[0]).toMatchObject({ replacedBy: undefined, autoApplied: false });
    expect(result.suggestions).toEqual([]);
  });

  it('writes the successor into the same row under the apply policy', () => {
    const result = sunset(withSuccessor(), { autoRemap: 'apply' });

    expect(result.transitions[0]).toMatchObject({ replacedBy: 'gpt-6', autoApplied: true });
    expect(result.suggestions).toEqual([]);
    expect(result.rows[0].patch).toMatchObject({
      lifecycle: { status: 'deprecated', replacedBy: 'gpt-6' },
    });
  });

  it('prefers the provider-declared replacement over the heuristic', () => {
    const base = new Map([active('gpt-5'), active('gpt-6'), active('gpt-4-turbo')]);
    const result = sunset(base, {
      autoRemap: 'apply',
      docs: new Map([
        [
          'gpt-5',
          {
            modelId: 'gpt-5',
            source: 'openai-docs',
            lifecycle: { status: 'deprecated' as const, replacedBy: 'gpt-4-turbo' },
            corroborated: false,
          },
        ],
      ]),
      ratesInForce: rates({ 'gpt-5': [2e-6, 8e-6], 'gpt-6': [1e-6, 4e-6], 'gpt-4-turbo': [1e-6, 4e-6] }),
    });

    expect(result.transitions[0].replacedBy).toBe('gpt-4-turbo');
  });

  it('prefers the rank-adjacent sibling when more than one shares the family', () => {
    const base = new Map([
      active('gpt-5', { rank: 10 }),
      active('gpt-6-mini', { rank: 90 }),
      active('gpt-6', { rank: 12 }),
    ]);
    const result = sunset(base, {
      ratesInForce: rates({ 'gpt-5': [2e-6, 8e-6], 'gpt-6': [1e-6, 4e-6], 'gpt-6-mini': [1e-7, 4e-7] }),
    });

    expect(result.suggestions[0].replacedBy).toBe('gpt-6');
  });

  describe('constraints', () => {
    /** Each case names ONE candidate through the docs channel, so exactly one clause can fail. */
    const declaring = (candidateId: string, base: Map<string, ResolvedCatalogRecord>, rateMap = {}) =>
      sunset(base, {
        autoRemap: 'apply',
        docs: new Map([
          [
            'gpt-5',
            {
              modelId: 'gpt-5',
              source: 'openai-docs',
              lifecycle: { status: 'deprecated' as const, replacedBy: candidateId },
              corroborated: false,
            },
          ],
        ]),
        ratesInForce: rates({ 'gpt-5': [2e-6, 8e-6], ...rateMap }),
      });

    it('refuses a replacement the catalog does not hold', () => {
      const result = declaring('gpt-7', new Map([active('gpt-5')]));

      expect(result.transitions[0].autoApplied).toBe(false);
      expect(result.suggestions[0].detail).toContain('the catalog holds no such model');
    });

    it('refuses a replacement that is not active', () => {
      const base = new Map([active('gpt-5'), active('gpt-6', { lifecycle: { status: 'discovered' } })]);
      const result = declaring('gpt-6', base, { 'gpt-6': [1e-6, 4e-6] });

      expect(result.suggestions[0].detail).toContain('it is not active');
    });

    it('refuses a declared replacement an OPERATOR row deprecated', () => {
      const result = sunset(new Map([active('gpt-5'), active('gpt-6')]), {
        autoRemap: 'apply',
        resolvedInForce: new Map([active('gpt-5'), active('gpt-6', { lifecycle: { status: 'deprecated' } })]),
        ratesInForce: rates({ 'gpt-5': [2e-6, 8e-6], 'gpt-6': [1e-6, 4e-6] }),
        docs: new Map([
          [
            'gpt-5',
            {
              modelId: 'gpt-5',
              source: 'openai-docs',
              lifecycle: { status: 'deprecated' as const, replacedBy: 'gpt-6' },
              corroborated: false,
            },
          ],
        ]),
      });

      expect(result.transitions[0].autoApplied).toBe(false);
      expect(result.suggestions[0].detail).toContain('it is not active');
    });

    it('refuses a replacement on another backend', () => {
      const base = new Map([
        active('gpt-5'),
        active('gpt-6', { backend: ModelBackend.Anthropic, vendor: 'anthropic' }),
      ]);
      const result = declaring('gpt-6', base, { 'gpt-6': [1e-6, 4e-6] });

      expect(result.suggestions[0].detail).toContain('another backend');
    });

    it('refuses a replacement that costs more', () => {
      const result = declaring('gpt-6', withSuccessor(), { 'gpt-6': [2e-6, 9e-6] });

      expect(result.suggestions[0].detail).toContain('costs more than the model it would replace');
    });

    it('refuses a replacement nothing prices, because unverifiable is not verified', () => {
      const result = declaring('gpt-6', withSuccessor());

      expect(result.suggestions[0].detail).toContain('cannot be verified');
    });

    it('refuses a replacement this same run is deprecating', () => {
      const base = new Map([active('gpt-5'), active('gpt-6')]);
      const result = plan({
        base,
        missed: ['gpt-5', 'gpt-6'],
        autoRemap: 'apply',
        statesBeforeRun: new Map([
          ['gpt-5', state({ modelId: 'gpt-5', missCount: 2, firstMissAt: new Date(RUN_AT.getTime() - 48 * HOUR) })],
          ['gpt-6', state({ modelId: 'gpt-6', missCount: 2, firstMissAt: new Date(RUN_AT.getTime() - 48 * HOUR) })],
        ]),
        ratesInForce: rates({ 'gpt-5': [2e-6, 8e-6], 'gpt-6': [1e-6, 4e-6] }),
        docs: new Map([
          [
            'gpt-5',
            {
              modelId: 'gpt-5',
              source: 'openai-docs',
              lifecycle: { status: 'deprecated' as const, replacedBy: 'gpt-6' },
              corroborated: false,
            },
          ],
        ]),
      });

      expect(result.transitions.find(transition => transition.modelId === 'gpt-5')).toMatchObject({
        replacedBy: undefined,
        autoApplied: false,
      });
      expect(result.suggestions[0]).toMatchObject({ modelId: 'gpt-5', replacedBy: 'gpt-6' });
      expect(result.suggestions[0].detail).toContain('it is itself deprecated');
    });
  });
});
