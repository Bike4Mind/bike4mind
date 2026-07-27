import {
  CATALOG_SCHEMA_VERSION,
  ModelBackend,
  type IModelCatalogRow,
  type IModelCatalogRowInput,
} from '@bike4mind/common';
import { resolveCatalogRecords } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import { testCredentials } from './__fixtures__/fakes';
import { planCatalogWrites, type CatalogWriteInput } from './catalogWrite';
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

  it('lets an aggregator enrich a model a provider already sighted', () => {
    const result = plan({
      resolveDispatch: dispatchable,
      contributions: [
        { name: 'openai', kind: 'provider', records: [gpt6()] },
        { name: 'models.dev', kind: 'aggregator', records: [{ modelId: 'gpt-6', patch: { supportsTools: true } }] },
      ],
    });

    expect(result.rows[0].patch).toMatchObject({ supportsTools: true });
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
});
