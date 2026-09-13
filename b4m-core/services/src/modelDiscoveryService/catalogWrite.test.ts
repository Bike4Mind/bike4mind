import {
  CATALOG_SCHEMA_VERSION,
  ModelBackend,
  type IModelCatalogRow,
  type IModelCatalogRowInput,
} from '@bike4mind/common';
import { resolveCatalogRecords } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import { testCredentials } from './__fixtures__/fakes';
import { DISCOVERY_CONTRIBUTOR, planCatalogWrites, type CatalogWriteInput } from './catalogWrite';
import type { DiscoveredModel } from './types';

const RUN_AT = new Date('2026-07-26T10:00:00Z');
const SEED_AT = new Date('2026-01-01T00:00:00Z');

const gpt6 = (patch: DiscoveredModel['patch'] = {}): DiscoveredModel => ({
  modelId: 'gpt-6',
  patch: {
    id: 'gpt-6',
    vendor: 'openai',
    backend: ModelBackend.OpenAI,
    type: 'text',
    name: 'GPT-6',
    contextWindow: 400_000,
    ...patch,
  },
});

const dispatchable: CatalogWriteInput['resolveDispatch'] = record =>
  record.backend === ModelBackend.OpenAI
    ? {
        adapterFamily: 'openai-chat',
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
      }
    : null;

const plan = (overrides: Partial<CatalogWriteInput> = {}) =>
  planCatalogWrites({
    contributions: [{ name: 'openai', kind: 'provider', records: [gpt6()] }],
    base: new Map(),
    // The default is a healthy run: every fixture is OpenAI-backed, so the
    // aggregator enrich-only rule is off unless a test asks for it.
    coveredBackends: new Set<string>([ModelBackend.OpenAI]),
    operatorOwnedModelIds: new Set(),
    credentials: testCredentials(),
    policy: 'priced',
    runStartedAt: RUN_AT,
    runId: 'run-1',
    ...overrides,
  });

/** Persist a planned row the way the collection would, then read it back as base. */
const asBase = (rows: IModelCatalogRowInput[], extra: IModelCatalogRow[] = []) =>
  resolveCatalogRecords([
    ...extra,
    ...rows.map(row => ({ ...row, schemaVersion: CATALOG_SCHEMA_VERSION }) as unknown as IModelCatalogRow),
  ]);

const seedRow = (patch: Record<string, unknown>, ownedGroups: string[]): IModelCatalogRow =>
  ({
    modelId: String(patch.id),
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: 'seed',
    ownedGroups,
    patch,
    effectiveFrom: SEED_AT,
  }) as unknown as IModelCatalogRow;

/** A curation row, which outranks discovery for the groups it owns and no others. */
const operatorRow = (patch: Record<string, unknown>, ownedGroups: string[]): IModelCatalogRow =>
  ({ ...seedRow(patch, ownedGroups), source: 'operator', effectiveFrom: RUN_AT }) as IModelCatalogRow;

describe('planCatalogWrites', () => {
  it('enters a new model as discovered and auto-disabled while it has no trusted price', () => {
    const result = plan({ resolveDispatch: dispatchable });

    expect(result.diff).toHaveLength(1);
    expect(result.diff[0]).toMatchObject({
      modelId: 'gpt-6',
      kind: 'added',
      lifecycleStatus: 'discovered',
      promoted: false,
      blockedBy: ['no-trusted-price'],
    });
    expect(result.rows[0].patch).toMatchObject({
      lifecycle: { status: 'discovered' },
      autoDisabled: true,
      autoDisabledReason: 'discovered, awaiting price',
    });
  });

  it('never writes the operator-owned disabled fields', () => {
    const patch = plan({ resolveDispatch: dispatchable }).rows[0].patch as Record<string, unknown>;

    expect(patch).not.toHaveProperty('disabled');
    expect(patch).not.toHaveProperty('disabledReason');
  });

  it('promotes a provider-priced model in a dispatchable family', () => {
    const result = plan({
      resolveDispatch: dispatchable,
      contributions: [
        {
          name: 'openai',
          kind: 'provider',
          records: [{ ...gpt6(), pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
        },
      ],
    });

    expect(result.diff[0]).toMatchObject({ promoted: true, lifecycleStatus: 'active', blockedBy: [] });
    expect(result.rows[0].patch).toMatchObject({ lifecycle: { status: 'active' }, autoDisabled: false });
    expect(result.rows[0].patch).not.toHaveProperty('autoDisabledReason');
  });

  it('appends nothing on a second run over identical source data', () => {
    const first = plan({ resolveDispatch: dispatchable });
    expect(first.rows).toHaveLength(1);

    const second = plan({ resolveDispatch: dispatchable, base: asBase(first.rows) });

    expect(second.rows).toHaveLength(0);
    expect(second.diff).toHaveLength(0);
    // The model was still sighted; only the write is suppressed.
    expect([...second.sightedModelIds]).toEqual(['gpt-6']);
  });

  it('appends again once a source reports a changed field', () => {
    const first = plan({ resolveDispatch: dispatchable });

    const second = plan({
      resolveDispatch: dispatchable,
      base: asBase(first.rows),
      contributions: [{ name: 'openai', kind: 'provider', records: [gpt6({ contextWindow: 1_000_000 })] }],
    });

    expect(second.diff[0]).toMatchObject({ kind: 'updated', changedKeys: ['contextWindow'] });
  });

  it('refuses to add a model only an aggregator has seen', () => {
    const result = plan({
      contributions: [{ name: 'models.dev', kind: 'aggregator', records: [gpt6()] }],
    });

    expect(result.rows).toHaveLength(0);
    expect(result.dropped).toEqual([
      { source: 'models.dev', modelId: 'gpt-6', reason: 'aggregator-only model with no catalog row' },
    ]);
  });

  it('does not count an aggregator listing as a sighting', () => {
    const base = asBase(
      [],
      [seedRow({ id: 'gpt-6', vendor: 'openai', backend: 'openai', type: 'text' }, ['identity'])]
    );
    const result = plan({
      base,
      contributions: [{ name: 'models.dev', kind: 'aggregator', records: [{ modelId: 'gpt-6', patch: {} }] }],
    });

    // The aggregators keep retired ids forever; treating one as evidence the
    // model still exists would freeze the absence protocol permanently.
    expect([...result.sightedModelIds]).toEqual([]);
  });

  it('keeps the dates a status-only lifecycle patch never mentioned', () => {
    const base = asBase(
      [],
      [
        seedRow(
          {
            id: 'gpt-6',
            vendor: 'openai',
            backend: 'openai',
            type: 'text',
            name: 'GPT-6',
            contextWindow: 400_000,
            lifecycle: { status: 'deprecated', deprecationDate: '2026-10-23' },
          },
          ['identity', 'limits', 'lifecycle']
        ),
      ]
    );
    const result = plan({
      base,
      contributions: [
        {
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: { lifecycle: { status: 'deprecated' } }, lifecycleEvidence: 'typed' }],
        },
      ],
    });

    // Same status, date carried forward: nothing changed, so nothing appends.
    // Wholesale object replacement would erase the date instead - and a past
    // date is what hides the model, so erasing it un-hides a sunset model.
    expect(result.rows).toEqual([]);
  });

  it('appends a status transition without erasing the dates already in force', () => {
    const base = asBase(
      [],
      [
        seedRow(
          {
            id: 'gpt-6',
            vendor: 'openai',
            backend: 'openai',
            type: 'text',
            name: 'GPT-6',
            contextWindow: 400_000,
            lifecycle: { status: 'active', deprecationDate: '2026-10-23' },
          },
          ['identity', 'limits', 'lifecycle']
        ),
      ]
    );
    const result = plan({
      base,
      contributions: [
        {
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: { lifecycle: { status: 'deprecated' } }, lifecycleEvidence: 'typed' }],
        },
      ],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].patch.lifecycle).toMatchObject({ status: 'deprecated', deprecationDate: '2026-10-23' });
  });

  describe('a model the catalog holds as sunset', () => {
    const deprecated = asBase(
      [],
      [
        seedRow(
          {
            id: 'gpt-6',
            vendor: 'openai',
            backend: 'openai',
            type: 'text',
            name: 'GPT-6',
            contextWindow: 400_000,
            lifecycle: { status: 'deprecated', deprecationDate: '2026-06-01' },
          },
          ['identity', 'limits', 'lifecycle']
        ),
      ]
    );

    it('records an announced date without letting it reactivate the model', () => {
      // litellm's shape for a future deprecation_date: a date and no status.
      const result = plan({
        base: deprecated,
        contributions: [
          {
            name: 'litellm',
            kind: 'aggregator',
            records: [{ modelId: 'gpt-6', patch: { lifecycle: { deprecationDate: '2026-11-30' } } }],
          },
          { name: 'openai', kind: 'provider', records: [gpt6()] },
        ],
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].patch.lifecycle).toEqual({ status: 'deprecated', deprecationDate: '2026-11-30' });
    });

    it('refuses a typed active claim from a provider and reports the disagreement', () => {
      const result = plan({
        base: deprecated,
        contributions: [
          {
            name: 'openai',
            kind: 'provider',
            records: [{ ...gpt6({ lifecycle: { status: 'active' } }), lifecycleEvidence: 'typed' }],
          },
        ],
      });

      // Resurrection is operator work: nothing changes, and the refusal is
      // counted rather than swallowed.
      expect(result.rows).toEqual([]);
      expect(result.dropped).toContainEqual({
        source: 'openai',
        modelId: 'gpt-6',
        reason:
          'lifecycle status "active" would resurrect a model the catalog holds as "deprecated"; kept "deprecated"',
      });
    });

    it('still lets one sunset status move to another', () => {
      const result = plan({
        base: deprecated,
        contributions: [
          {
            name: 'openai',
            kind: 'provider',
            records: [{ ...gpt6({ lifecycle: { status: 'retired' } }), lifecycleEvidence: 'typed' }],
          },
        ],
      });

      expect(result.rows[0].patch.lifecycle).toEqual({ status: 'retired', deprecationDate: '2026-06-01' });
    });
  });

  it('drops a lifecycle date no status in force can carry', () => {
    const result = plan({
      contributions: [
        { name: 'openai', kind: 'provider', records: [gpt6()] },
        {
          name: 'litellm',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: { lifecycle: { deprecationDate: '2026-11-30' } } }],
        },
      ],
    });

    // The model is new, so there is no status for the date to hide it at. The
    // row still enters the model, at the status the promotion decision gives it,
    // and the date is counted as refused rather than written.
    expect(result.rows[0].patch.lifecycle).toEqual({ status: 'discovered' });
    expect(result.dropped).toContainEqual({
      source: 'litellm',
      modelId: 'gpt-6',
      reason: 'lifecycle dates with no status behind them, in the patch or in force',
    });
  });

  describe('a sunset declared while the model is still discovered', () => {
    /** gpt-6 as a previous run left it: entered, not yet promoted. */
    const discovered = asBase(
      [],
      [
        seedRow(
          {
            id: 'gpt-6',
            vendor: 'openai',
            backend: 'openai',
            type: 'text',
            name: 'GPT-6',
            contextWindow: 400_000,
            lifecycle: { status: 'discovered' },
          },
          ['identity', 'limits', 'lifecycle']
        ),
      ]
    );

    /** A trusted price and a typed sunset arriving in the same run. */
    const sunsetting = (base = discovered) =>
      plan({
        base,
        resolveDispatch: dispatchable,
        contributions: [
          {
            name: 'openai',
            kind: 'provider',
            records: [{ ...gpt6(), pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
          },
          {
            name: 'litellm',
            kind: 'aggregator',
            records: [
              {
                modelId: 'gpt-6',
                patch: { lifecycle: { status: 'deprecated', deprecationDate: '2026-01-15' } },
                lifecycleEvidence: 'typed',
              },
            ],
          },
        ],
      });

    it('writes the declared status and dates instead of promoting the model', () => {
      const result = sunsetting();

      // The price would satisfy the promotion predicate, and promoting would
      // overwrite the sunset with 'active' while keeping its dates.
      expect(result.diff[0]).toMatchObject({
        modelId: 'gpt-6',
        lifecycleStatus: 'deprecated',
        promoted: false,
        blockedBy: [],
      });
      expect(result.rows[0].patch).toMatchObject({
        lifecycle: { status: 'deprecated', deprecationDate: '2026-01-15' },
      });
      // Nothing decided availability, so the row claims nothing there either.
      expect(result.rows[0].ownedGroups).not.toContain('availability');
      expect(result.rows[0].patch).not.toHaveProperty('autoDisabled');
    });

    it('appends nothing on the next plan over the same sunset', () => {
      const result = sunsetting(asBase(sunsetting().rows));

      expect(result.rows).toEqual([]);
      expect(result.diff).toEqual([]);
    });
  });

  it('lets an aggregator enrich a model a provider already sighted', () => {
    // supportsVision rather than supportsTools: an introduced OpenAI model has
    // its tools withheld deliberately, which is its own case below.
    const result = plan({
      resolveDispatch: dispatchable,
      contributions: [
        { name: 'openai', kind: 'provider', records: [gpt6()] },
        { name: 'models.dev', kind: 'aggregator', records: [{ modelId: 'gpt-6', patch: { supportsVision: true } }] },
      ],
    });

    expect(result.rows[0].patch).toMatchObject({ supportsVision: true });
    expect(result.rows[0].contributors).toContainEqual({ group: 'modalities', source: 'models.dev' });
    expect(result.rows[0].contributors).toContainEqual({ group: 'identity', source: 'openai' });
  });

  it('keeps the provider value when an aggregator disagrees', () => {
    const result = plan({
      resolveDispatch: dispatchable,
      contributions: [
        { name: 'models.dev', kind: 'aggregator', records: [gpt6({ contextWindow: 1 })] },
        { name: 'openai', kind: 'provider', records: [gpt6({ contextWindow: 400_000 })] },
      ],
    });

    expect(result.rows[0].patch).toMatchObject({ contextWindow: 400_000 });
  });

  it('re-claims the groups the discovery row it supersedes held', () => {
    const discovered = plan({ resolveDispatch: dispatchable });
    const base = asBase(discovered.rows);

    // Anthropic-style outage: only the aggregator reports, and only limits.
    const next = plan({
      base,
      coveredBackends: new Set<string>(),
      priorDiscoveryGroups: new Map([['gpt-6', discovered.rows[0].ownedGroups]]),
      priorContributors: new Map([['gpt-6', discovered.rows[0].contributors ?? []]]),
      contributions: [
        { name: 'openai', kind: 'provider', records: [gpt6({ contextWindow: 500_000 })] },
        { name: 'models.dev', kind: 'aggregator', records: [{ modelId: 'gpt-6', patch: { maxOutputTokens: 64_000 } }] },
      ],
    });

    // Claiming only {limits} would leave identity with no row behind it and the
    // merged record would fail asRenderableRecord on missing id/vendor/name.
    expect(next.rows[0].ownedGroups).toEqual(expect.arrayContaining(['identity', 'lifecycle', 'availability']));
    expect(next.rows[0].patch).toMatchObject({ id: 'gpt-6', vendor: 'openai', name: 'GPT-6' });
    expect(next.rows[0].contributors).toContainEqual({ group: 'dispatch', source: 'seed' });
  });

  it('lets an aggregator fill a gap but not overwrite when no provider listed the backend', () => {
    const base = asBase(
      [],
      [
        seedRow(
          {
            id: 'gpt-6',
            vendor: 'openai',
            backend: 'openai',
            type: 'text',
            name: 'GPT-6',
            contextWindow: 400_000,
            lifecycle: { status: 'active' },
          },
          ['identity', 'limits', 'lifecycle']
        ),
      ]
    );

    const result = plan({
      base,
      coveredBackends: new Set<string>(),
      contributions: [
        {
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: { contextWindow: 128_000, maxOutputTokens: 64_000 } }],
        },
      ],
    });

    expect(result.rows[0].patch).toMatchObject({ contextWindow: 400_000, maxOutputTokens: 64_000 });
    expect(result.dropped).toContainEqual({
      source: 'models.dev',
      modelId: 'gpt-6',
      reason: 'aggregator may not overwrite "contextWindow" on a run no openai listing succeeded',
    });
  });

  it("lets an aggregator update once the model's own backend listed successfully", () => {
    const base = asBase(
      [],
      [
        seedRow(
          {
            id: 'gpt-6',
            vendor: 'openai',
            backend: 'openai',
            type: 'text',
            name: 'GPT-6',
            contextWindow: 400_000,
            lifecycle: { status: 'active' },
          },
          ['identity', 'limits', 'lifecycle']
        ),
      ]
    );

    const result = plan({
      base,
      contributions: [
        { name: 'models.dev', kind: 'aggregator', records: [{ modelId: 'gpt-6', patch: { contextWindow: 128_000 } }] },
      ],
    });

    expect(result.rows[0].patch).toMatchObject({ contextWindow: 128_000 });
  });

  it('drops malformed and unknown source data instead of writing it', () => {
    const result = plan({
      contributions: [
        {
          name: 'openai',
          kind: 'provider',
          records: [
            { modelId: '', patch: { name: 'nameless' } },
            { modelId: 'gpt-7', patch: null as unknown as DiscoveredModel['patch'] },
            { modelId: 'gpt-8', patch: { somethingNew: true } as unknown as DiscoveredModel['patch'] },
          ],
        },
      ],
    });

    expect(result.rows).toHaveLength(0);
    expect(result.dropped.map(drop => drop.reason)).toEqual([
      'record has no modelId',
      'record patch is not an object',
      'unknown field "somethingNew"',
      'record carries no usable fields',
    ]);
  });

  it('drops feed contributions to the seed- and operator-owned groups', () => {
    const result = plan({
      resolveDispatch: dispatchable,
      contributions: [
        {
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: { rank: 1, adapterFamily: 'openai-responses' } }],
        },
        { name: 'openai', kind: 'provider', records: [gpt6()] },
      ],
    });

    expect(result.dropped.map(drop => drop.reason).sort()).toEqual([
      'field "adapterFamily" is seed- or operator-owned',
      'field "rank" is seed- or operator-owned',
      'record carries no usable fields',
    ]);
    expect(result.rows[0].patch).not.toHaveProperty('rank');
    expect(result.rows[0].patch).toMatchObject({ adapterFamily: 'openai-chat' });
  });

  it('leaves the lifecycle and auto-disable of an already-active model alone', () => {
    const base = asBase(
      [],
      [
        seedRow(
          { id: 'gpt-6', vendor: 'openai', backend: 'openai', type: 'text', name: 'GPT-6', contextWindow: 400_000 },
          ['identity', 'limits']
        ),
        seedRow({ id: 'gpt-6', lifecycle: { status: 'active' } }, ['lifecycle']),
      ]
    );

    const result = plan({
      base,
      credentials: testCredentials({ openai: null }),
      contributions: [{ name: 'openai', kind: 'provider', records: [gpt6({ contextWindow: 500_000 })] }],
    });

    expect(result.rows[0].ownedGroups).toEqual(['identity', 'limits']);
    expect(result.rows[0].patch).not.toHaveProperty('autoDisabled');
    expect(result.diff[0].blockedBy).toEqual([]);
  });

  it('stays metadata-only when nothing can derive a dispatch profile', () => {
    const result = plan();

    expect(result.diff[0]).toMatchObject({
      lifecycleStatus: 'discovered',
      blockedBy: ['no-adapter-family', 'no-dispatch-profile', 'no-trusted-price'],
    });
  });

  it('flags a model an operator already has a row for', () => {
    const result = plan({ resolveDispatch: dispatchable, operatorOwnedModelIds: new Set(['gpt-6']) });

    expect(result.diff[0].operatorOwned).toBe(true);
  });

  it('trusts two aggregators that agree and distrusts a lone one', () => {
    const agreeing = plan({
      resolveDispatch: dispatchable,
      contributions: [
        { name: 'openai', kind: 'provider', records: [gpt6()] },
        {
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: {}, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
        },
        {
          name: 'litellm',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: {}, pricing: { inputPerMTok: 2.05, outputPerMTok: 8.1 } }],
        },
      ],
    });
    const alone = plan({
      resolveDispatch: dispatchable,
      contributions: [
        { name: 'openai', kind: 'provider', records: [gpt6()] },
        {
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: {}, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
        },
      ],
    });

    expect(agreeing.diff[0].promoted).toBe(true);
    expect(alone.diff[0].blockedBy).toEqual(['no-trusted-price']);
  });

  // A text row whose output reserve eats its whole context window makes safeInputWindow
  // non-positive, and the chat path then refuses to build a prompt at all. The static tables are
  // held to that by modelCatalogInputBudget.test.ts; these cover the feed, which outranks them.
  describe('maxOutputTokens that would starve the input budget', () => {
    const claiming = (patch: DiscoveredModel['patch']) => ({
      contributions: [{ name: 'openai' as const, kind: 'provider' as const, records: [gpt6(patch)] }],
    });
    const gpt6Seed = (patch: Record<string, unknown>) =>
      seedRow(
        {
          id: 'gpt-6',
          vendor: 'openai',
          backend: ModelBackend.OpenAI,
          type: 'text',
          name: 'GPT-6',
          contextWindow: 400_000,
          ...patch,
        },
        ['identity', 'limits']
      );

    it('refuses the claim and reports it, keeping the rest of the record', () => {
      const result = plan({ resolveDispatch: dispatchable, ...claiming({ maxOutputTokens: 400_000 }) });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].patch).not.toHaveProperty('maxOutputTokens');
      expect(result.rows[0].patch).toMatchObject({ contextWindow: 400_000 });
      expect(result.dropped).toContainEqual({
        source: 'openai',
        modelId: 'gpt-6',
        reason:
          'maxOutputTokens 400000 leaves no input budget in a contextWindow of 400000 (safety buffer 1000); maxOutputTokens dropped',
      });
    });

    it('leaves the value in force standing when the starving claim was the only limits field', () => {
      // The starving claim is refused and the seed's own non-starving figure is carried forward, so
      // the draft matches what is already in force and nothing is appended. Clamping instead would
      // append a row and overwrite it.
      const seed = gpt6Seed({ maxOutputTokens: 32_000 });
      const result = plan({
        base: asBase([], [seed]),
        resolveDispatch: dispatchable,
        contributions: [
          { name: 'openai', kind: 'provider', records: [{ modelId: 'gpt-6', patch: { maxOutputTokens: 400_000 } }] },
        ],
      });

      expect(result.rows).toEqual([]);
      expect(asBase(result.rows, [seed]).get('gpt-6')?.record.maxOutputTokens).toBe(32_000);
      expect(result.dropped.map(drop => drop.reason)).toContain(
        'maxOutputTokens 400000 leaves no input budget in a contextWindow of 400000 (safety buffer 1000); ' +
          'carried forward the in-force maxOutputTokens 32000'
      );
    });

    it('carries the cap in force forward when the starving claim wins the limits group', () => {
      // The common case: a feed sends a bogus maxOutputTokens alongside a real contextWindow, so
      // the appended row wins the whole `limits` group. Deleting the field would drop the read path
      // to DEFAULT_MAX_OUTPUT_TOKENS (4096) - a 31x cut on a frontier model - so the non-starving
      // 128000 already in force is carried forward and credited to discovery, not the feed.
      const seed = gpt6Seed({ maxOutputTokens: 128_000 });
      const result = plan({
        base: asBase([], [seed]),
        resolveDispatch: dispatchable,
        contributions: [
          {
            name: 'openai',
            kind: 'provider',
            records: [{ modelId: 'gpt-6', patch: { contextWindow: 1_000_000, maxOutputTokens: 1_000_000 } }],
          },
        ],
      });

      expect(result.rows[0].patch).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
      expect(result.rows[0].contributors).toContainEqual({ group: 'limits', source: 'discovery' });
      expect(asBase(result.rows, [seed]).get('gpt-6')?.record.maxOutputTokens).toBe(128_000);
      expect(result.dropped.map(drop => drop.reason)).toContain(
        'maxOutputTokens 1000000 leaves no input budget in a contextWindow of 1000000 (safety buffer 1000); ' +
          'carried forward the in-force maxOutputTokens 128000'
      );
    });

    it('drops the field when the value in force also starves the window', () => {
      // A window lowered under the cap already in force: the held value cannot be carried, so the
      // field drops and the read path takes over. Same shape as the mirror case below.
      const seed = gpt6Seed({ maxOutputTokens: 200_000 });
      const result = plan({
        base: asBase([], [seed]),
        resolveDispatch: dispatchable,
        contributions: [
          {
            name: 'openai',
            kind: 'provider',
            records: [{ modelId: 'gpt-6', patch: { contextWindow: 100_000, maxOutputTokens: 100_000 } }],
          },
        ],
      });

      expect(result.rows[0].patch).toMatchObject({ contextWindow: 100_000 });
      expect(result.rows[0].patch).not.toHaveProperty('maxOutputTokens');
      expect(result.dropped.map(drop => drop.reason)).toContain(
        'maxOutputTokens 100000 leaves no input budget in a contextWindow of 100000 (safety buffer 1000); maxOutputTokens dropped'
      );
    });

    it('persists a claim that leaves room, and says nothing', () => {
      const result = plan({ resolveDispatch: dispatchable, ...claiming({ maxOutputTokens: 128_000 }) });

      expect(result.rows[0].patch).toMatchObject({ maxOutputTokens: 128_000 });
      expect(result.dropped).toEqual([]);
    });

    it('leaves a media claim alone, where max output is the prompt-length limit', () => {
      const result = plan({
        resolveDispatch: dispatchable,
        ...claiming({ type: 'image', contextWindow: 10_000, maxOutputTokens: 10_000 }),
      });

      expect(result.rows[0].patch).toMatchObject({ maxOutputTokens: 10_000 });
      expect(result.dropped).toEqual([]);
    });

    it('catches a claim that lowers only contextWindow onto an output cap already in force', () => {
      // The mirror case, and the one a real feed produces: the Kimi and xAI provider sources emit
      // contextWindow and never maxOutputTokens. A window lowered to whatever the catalog already
      // holds as the output cap is the same starving pair, arriving from the other side.
      const seed = gpt6Seed({ maxOutputTokens: 131_072, contextWindow: 262_144 });
      const result = plan({
        base: asBase([], [seed]),
        resolveDispatch: dispatchable,
        contributions: [
          { name: 'openai', kind: 'provider', records: [{ modelId: 'gpt-6', patch: { contextWindow: 131_072 } }] },
        ],
      });

      expect(result.rows[0].patch).toMatchObject({ contextWindow: 131_072 });
      expect(result.rows[0].patch).not.toHaveProperty('maxOutputTokens');
      expect(result.dropped.map(drop => drop.reason)).toContain(
        'maxOutputTokens 131072 leaves no input budget in a contextWindow of 131072 (safety buffer 1000); maxOutputTokens dropped'
      );
    });

    it('clamps rather than refuses when the window cannot fund the read-path fallback', () => {
      // Refusing here would hand the read path min(contextWindow, DEFAULT_MAX_OUTPUT_TOKENS), which
      // starves just as badly. The model still answers at a lower output setting, so it keeps its
      // row with a reserve that leaves room: half of what is left after the buffer.
      const result = plan({
        resolveDispatch: dispatchable,
        ...claiming({ contextWindow: 4_096, maxOutputTokens: 4_096 }),
      });

      expect(result.rows[0].patch).toMatchObject({ maxOutputTokens: 1_548 });
      expect(4_096 - 1_548 - 1_000).toBeGreaterThan(0);
      expect(result.dropped).toContainEqual({
        source: 'openai',
        modelId: 'gpt-6',
        reason:
          'maxOutputTokens 4096 leaves no input budget in a contextWindow of 4096 (safety buffer 1000); clamped to 1548',
      });
    });

    it('drops a window at or under the buffer, where no reserve leaves room', () => {
      const result = plan({
        resolveDispatch: dispatchable,
        ...claiming({ contextWindow: 1_000, maxOutputTokens: 1_000 }),
      });

      expect(result.rows).toEqual([]);
      expect(result.dropped).toContainEqual({
        source: 'openai',
        modelId: 'gpt-6',
        reason:
          'maxOutputTokens 1000 leaves no input budget in a contextWindow of 1000 (safety buffer 1000); no reserve leaves room for a prompt',
      });
    });
  });

  it('distrusts two aggregators that disagree beyond the tolerance', () => {
    const result = plan({
      resolveDispatch: dispatchable,
      contributions: [
        { name: 'openai', kind: 'provider', records: [gpt6()] },
        {
          name: 'models.dev',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: {}, pricing: { inputPerMTok: 2, outputPerMTok: 8 } }],
        },
        {
          name: 'litellm',
          kind: 'aggregator',
          records: [{ modelId: 'gpt-6', patch: {}, pricing: { inputPerMTok: 20, outputPerMTok: 80 } }],
        },
      ],
    });

    expect(result.diff[0].blockedBy).toEqual(['no-trusted-price']);
  });

  describe('introducing a model no source describes fully', () => {
    /** The openai source's output for a new id whose docs page it read: no window. */
    const astra = (patch: DiscoveredModel['patch'] = {}): DiscoveredModel => ({
      modelId: 'gpt-6-astra',
      patch: {
        id: 'gpt-6-astra',
        vendor: 'openai',
        backend: ModelBackend.OpenAI,
        type: 'text',
        name: 'GPT-6 Astra',
        ...patch,
      },
    });

    const introduce = (records: DiscoveredModel[], overrides: Partial<CatalogWriteInput> = {}) =>
      plan({ contributions: [{ name: 'openai', kind: 'provider', records }], ...overrides });

    /** The listing record alone: what an id whose docs page was never read leaves. */
    const unnamed = (modelId: string, type: NonNullable<DiscoveredModel['patch']['type']>): DiscoveredModel => ({
      modelId,
      patch: { id: modelId, vendor: 'openai', backend: ModelBackend.OpenAI, type },
    });

    it('refuses an OpenAI introduction no docs page named', () => {
      const result = introduce([unnamed('gpt-5.7', 'text')]);

      expect(result.rows).toHaveLength(0);
      // The reason names the cause, so a docs host that moved reads as itself in
      // the run report instead of as an absence of new models.
      expect(result.dropped[0].reason).toContain('no docs page supplied a name');
      expect(result.sightedModelIds.has('gpt-5.7')).toBe(true);
    });

    it('refuses the legacy pins and non-product ids the chat namespaces classify', () => {
      // All of these are `type: 'text'` to the OpenAI source, and all of them
      // sort ahead of a genuinely new id in the probe queue's tie-break.
      const ids = [
        'gpt-3.5-turbo-16k',
        'gpt-3.5-turbo-instruct',
        'gpt-4-32k',
        'gpt-4o-search-preview',
        'chatgpt-4o-latest',
        'codex-mini-latest',
      ];

      const result = introduce(ids.map(id => unnamed(id, 'text')));

      expect(result.rows).toHaveLength(0);
      expect(result.dropped).toHaveLength(ids.length);
    });

    it('refuses the non-text ids it can classify but nobody names', () => {
      const result = introduce([
        unnamed('text-embedding-ada-002', 'embedding'),
        unnamed('tts-1-hd', 'tts'),
        unnamed('dall-e-2', 'image'),
        unnamed('gpt-realtime', 'realtime-voice'),
      ]);

      expect(result.rows).toHaveLength(0);
    });

    it('still names a backend with no docs parser off its listed id', () => {
      // kimi, xai and bfl list the product id itself, so the id IS the label and
      // the default is the only name available.
      const result = introduce([
        {
          modelId: 'kimi-k3',
          patch: {
            id: 'kimi-k3',
            vendor: 'moonshotai',
            backend: ModelBackend.Kimi,
            type: 'text',
            contextWindow: 256_000,
          },
        },
      ]);

      expect(result.rows[0].patch).toMatchObject({ name: 'kimi-k3' });
      expect(result.rows[0].ownedGroups).toContain('identity');
    });

    it('lands the row on the name the docs page supplied', () => {
      const result = introduce([astra()]);

      expect(result.diff[0]).toMatchObject({ modelId: 'gpt-6-astra', kind: 'added' });
      expect(result.rows[0].patch).toMatchObject({ name: 'GPT-6 Astra' });
      expect(result.rows[0].ownedGroups).toContain('identity');
    });

    it('leaves the context window it had to invent inert on the read path', () => {
      const result = introduce([astra()]);

      // A zero satisfies the append schema; NOT claiming `limits` is what stops
      // it beating the real window an aggregator supplies on the next pass.
      expect(result.rows[0].patch).toMatchObject({ contextWindow: 0 });
      expect(result.rows[0].ownedGroups).not.toContain('limits');
      expect(asBase(result.rows).get('gpt-6-astra')?.record).not.toHaveProperty('contextWindow');
    });

    it('claims the limits group for a window a source did supply', () => {
      const result = introduce([astra({ contextWindow: 1_050_000 })]);

      expect(result.rows[0].patch).toMatchObject({ contextWindow: 1_050_000 });
      expect(result.rows[0].ownedGroups).toContain('limits');
    });

    it('reports the append schema rejection for a record it still cannot complete', () => {
      // `type` is the one required field that cannot be defaulted honestly: the
      // OpenAI source omits it for a namespace it does not recognize rather than
      // labelling a new modality 'text'.
      const result = introduce([
        {
          modelId: 'gpt-audio',
          patch: { id: 'gpt-audio', vendor: 'openai', backend: ModelBackend.OpenAI, name: 'GPT Audio' },
        },
      ]);

      expect(result.rows).toHaveLength(0);
      expect(result.dropped[0].reason).toContain('record failed the append schema');
      expect(result.sightedModelIds.has('gpt-audio')).toBe(true);
    });

    it('drops an output cap it has no window to claim the group alongside', () => {
      const result = introduce([{ ...astra(), patch: { ...astra().patch, maxOutputTokens: 64_000 } }]);

      expect(result.rows[0].patch).not.toHaveProperty('maxOutputTokens');
      expect(result.rows[0].ownedGroups).not.toContain('limits');
      expect(result.dropped.map(drop => drop.reason)).toContain(
        'maxOutputTokens dropped: no context window to claim the limits group alongside it'
      );
    });

    it('appends nothing over a model the catalog already names', () => {
      const base = asBase(
        [],
        [
          seedRow(
            {
              id: 'gpt-6-astra',
              vendor: 'openai',
              backend: 'openai',
              type: 'text',
              name: 'GPT-6 Astra',
              contextWindow: 1_050_000,
            },
            ['identity', 'limits']
          ),
        ]
      );

      // Introduction-only, so a run over a model the catalog already names has
      // nothing to change and appends nothing.
      const result = introduce([astra()], { base });

      expect(result.rows).toHaveLength(0);
      expect(base.get('gpt-6-astra')?.record).toMatchObject({ name: 'GPT-6 Astra' });
    });

    it('withholds tools on introduction, over a source that says otherwise', () => {
      // The pin defers the one dispatch field the id cannot reveal: which of
      // OpenAI's two tool conventions the model's endpoint takes. A feed's "it
      // has tools" is not that claim, so it loses.
      const result = plan({
        contributions: [
          { name: 'openai', kind: 'provider', records: [astra()] },
          {
            name: 'models.dev',
            kind: 'aggregator',
            records: [{ modelId: 'gpt-6-astra', patch: { supportsTools: true } }],
          },
        ],
      });

      expect(result.rows[0].patch).toMatchObject({ supportsTools: false });
      expect(result.rows[0].ownedGroups).toContain('modalities');
      expect(result.dropped.map(drop => drop.reason)).toContain(
        'supportsTools claim refused: tools stay withheld until the toolTransport is verified'
      );
    });

    it('withholds tools from a model an operator merely pinned', () => {
      // operatorOwnedModelIds means "SOME operator row exists" and precedence is
      // per field group, so a rank or display-name pin owns no `modalities` and
      // cannot answer which tool transport the model takes.
      const result = plan({
        operatorOwnedModelIds: new Set(['gpt-6-astra']),
        contributions: [
          { name: 'openai', kind: 'provider', records: [astra()] },
          {
            name: 'models.dev',
            kind: 'aggregator',
            records: [{ modelId: 'gpt-6-astra', patch: { supportsTools: true } }],
          },
        ],
      });

      expect(result.rows[0].patch).toMatchObject({ supportsTools: false });
      expect(result.rows[0].patch).not.toHaveProperty('dispatchProfile');
      expect(result.rows[0].ownedGroups).toContain('modalities');
    });

    it('lets an operator row that owns modalities carry the tools it claims', () => {
      const result = plan({
        operatorOwnedModelIds: new Set(['gpt-6-astra']),
        contributions: [{ name: 'openai', kind: 'provider', records: [astra()] }],
      });

      const merged = asBase(result.rows, [operatorRow({ id: 'gpt-6-astra', supportsTools: true }, ['modalities'])]);

      expect(merged.get('gpt-6-astra')?.record.supportsTools).toBe(true);
    });

    it('leaves the tools of a model already holding them alone', () => {
      const base = asBase(
        [],
        [
          seedRow(
            { id: 'gpt-6', vendor: 'openai', backend: 'openai', type: 'text', name: 'GPT-6', contextWindow: 400_000 },
            ['identity', 'limits']
          ),
          seedRow({ id: 'gpt-6', supportsTools: true, lifecycle: { status: 'active' } }, ['modalities', 'lifecycle']),
        ]
      );

      const result = plan({
        base,
        contributions: [{ name: 'openai', kind: 'provider', records: [gpt6({ contextWindow: 500_000 })] }],
      });

      expect(result.rows[0].patch).toMatchObject({ supportsTools: true });
      expect(result.rows[0].ownedGroups).not.toContain('modalities');
    });

    describe('a probe-verified dispatch group', () => {
      const RUN_2 = new Date(RUN_AT.getTime() + 60_000);
      const RUN_3 = new Date(RUN_AT.getTime() + 120_000);

      /** What resolveDispatchForRecord returns for every OpenAI id: a family, no profile. */
      const familyOnly: CatalogWriteInput['resolveDispatch'] = record =>
        record.backend === ModelBackend.OpenAI ? { adapterFamily: 'openai-chat' } : null;

      const probedResponses = new Map([
        [
          'gpt-6-astra',
          {
            adapterFamily: 'openai-responses' as const,
            dispatchProfile: { maxTokensParam: 'max_completion_tokens' as const, toolTransport: 'responses' as const },
          },
        ],
      ]);

      /**
       * The catalog as the runtime reads it after a run: rowsInForce keeps ONE
       * discovery row per model, so the next run diffs against that row alone and
       * re-claims its groups.
       */
      const afterRun = (row: IModelCatalogRowInput): Partial<CatalogWriteInput> => ({
        base: asBase([row]),
        priorDiscoveryGroups: new Map([[row.modelId, row.ownedGroups]]),
      });

      it('overwrites the family the resolver guessed, because the probe verified it', () => {
        const introduced = introduce([astra()], { resolveDispatch: familyOnly });
        expect(introduced.rows[0].patch).toMatchObject({ adapterFamily: 'openai-chat' });
        expect(introduced.rows[0].patch).not.toHaveProperty('dispatchProfile');

        const probed = introduce([astra()], {
          ...afterRun(introduced.rows[0]),
          resolveDispatch: familyOnly,
          probedProfiles: probedResponses,
          runStartedAt: RUN_2,
        });

        // Both halves move together or the model dispatches through a family
        // that contradicts its own transport.
        expect(probed.rows[0].patch).toMatchObject({
          adapterFamily: 'openai-responses',
          dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'responses' },
          supportsTools: true,
        });
        expect(probed.rows[0].ownedGroups).toContain('dispatch');
        expect(probed.rows[0].ownedGroups).toContain('modalities');
        // Provenance: verified here, not derived by the seed layer.
        expect(probed.rows[0].contributors).toContainEqual({ group: 'dispatch', source: DISCOVERY_CONTRIBUTOR });
      });

      it('keeps those tools on the next run, which does not probe again', () => {
        const introduced = introduce([astra()], { resolveDispatch: familyOnly });
        const probed = introduce([astra()], {
          ...afterRun(introduced.rows[0]),
          resolveDispatch: familyOnly,
          probedProfiles: probedResponses,
          runStartedAt: RUN_2,
        });
        expect(probed.rows[0].patch).toMatchObject({ supportsTools: true });

        // A model with a dispatchProfile is no longer a probe candidate, so
        // `probed` is false here. Without the supportsTools claim in the row
        // above, the pin re-engages off the withheld introducing row and the
        // model flip-flops between tools-on and tools-off run after run.
        const later = plan({
          ...afterRun(probed.rows[0]),
          resolveDispatch: familyOnly,
          runStartedAt: RUN_3,
          contributions: [
            { name: 'openai', kind: 'provider', records: [astra()] },
            {
              name: 'models.dev',
              kind: 'aggregator',
              records: [{ modelId: 'gpt-6-astra', patch: { supportsTools: true } }],
            },
          ],
        });

        expect(later.dropped.map(drop => drop.reason)).not.toContain(
          'supportsTools claim refused: tools stay withheld until the toolTransport is verified'
        );
        expect(later.rows.map(row => (row.patch as Record<string, unknown>).supportsTools)).not.toContain(false);
      });

      it('leaves the tools of a model this run did not probe withheld', () => {
        const introduced = introduce([astra()], { resolveDispatch: familyOnly });

        const later = introduce([astra()], {
          ...afterRun(introduced.rows[0]),
          resolveDispatch: familyOnly,
          probedProfiles: new Map(),
          runStartedAt: RUN_2,
        });

        expect(later.rows.map(row => (row.patch as Record<string, unknown>).supportsTools)).not.toContain(true);
      });
    });

    it('sights a dated snapshot and a fine-tune without introducing either', () => {
      const result = introduce([
        astra(),
        {
          modelId: 'gpt-6-astra-2026-09-01',
          patch: { id: 'gpt-6-astra-2026-09-01', vendor: 'openai', backend: ModelBackend.OpenAI, type: 'text' },
        },
        {
          modelId: 'ft:gpt-6-astra:acme::x1',
          patch: { id: 'ft:gpt-6-astra:acme::x1', vendor: 'openai', backend: ModelBackend.OpenAI, type: 'text' },
        },
      ]);

      expect(result.diff.map(entry => entry.modelId)).toEqual(['gpt-6-astra']);
      expect(result.dropped.filter(drop => drop.reason.includes('not a model to introduce'))).toHaveLength(2);
      // Still sighted: the absence protocol counts a miss streak per id, and an
      // id it never hears about looks like one the provider stopped listing.
      expect([...result.sightedModelIds].sort()).toEqual([
        'ft:gpt-6-astra:acme::x1',
        'gpt-6-astra',
        'gpt-6-astra-2026-09-01',
      ]);
    });

    it('keeps updating a snapshot the catalog already holds', () => {
      const base = asBase(
        [],
        [
          seedRow(
            {
              id: 'gpt-6-astra-2026-09-01',
              vendor: 'openai',
              backend: 'openai',
              type: 'text',
              name: 'GPT-6 Astra (2026-09-01)',
              contextWindow: 400_000,
            },
            ['identity', 'limits']
          ),
        ]
      );

      const result = introduce(
        [
          {
            modelId: 'gpt-6-astra-2026-09-01',
            patch: {
              id: 'gpt-6-astra-2026-09-01',
              vendor: 'openai',
              backend: ModelBackend.OpenAI,
              type: 'text',
              contextWindow: 1_050_000,
            },
          },
        ],
        { base }
      );

      expect(result.diff[0]).toMatchObject({ modelId: 'gpt-6-astra-2026-09-01', kind: 'updated' });
      expect(result.rows[0].patch).toMatchObject({ contextWindow: 1_050_000 });
    });
  });
});
