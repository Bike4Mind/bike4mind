import { describe, it, expect, afterEach } from 'vitest';
import { ChatModels, ModelBackend, toModelRecord } from '@bike4mind/common';
import type { IModelCatalogRow, ModelInfo } from '@bike4mind/common';
import { getAvailableModels, setModelCatalogProvider, setModelPriceRowsProvider } from './index';
import { mergeCatalog, mergeCatalogWithDrops } from './mergeCatalog';
import type { BackendGateContext } from './backendGate';

const NO_KEYS: BackendGateContext = { apiKeys: null, isSelfHost: false };

const seedModel = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id: ChatModels.GPT4_1,
  type: 'text',
  name: 'GPT 4.1',
  backend: ModelBackend.OpenAI,
  contextWindow: 128_000,
  max_tokens: 16_384,
  pricing: { 128_000: { input: 2e-6, output: 8e-6 } },
  can_stream: true,
  supportsTools: true,
  supportsImageVariation: false,
  rank: 5,
  description: 'the seeded description',
  ...overrides,
});

const row = (overrides: Partial<IModelCatalogRow> & Pick<IModelCatalogRow, 'modelId'>): IModelCatalogRow => ({
  schemaVersion: 1,
  source: 'discovery',
  ownedGroups: [],
  patch: {},
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('mergeCatalog: the empty-catalog identity (the Phase 1 no-behavior-change proof)', () => {
  it('returns the very same array when the catalog is empty', () => {
    const seeds = [seedModel(), seedModel({ id: ChatModels.GPT4_O, name: 'GPT 4o' })];
    // Identity, not deep equality: an absent catalog must not even rebuild the list.
    expect(mergeCatalog(seeds, [], NO_KEYS)).toBe(seeds);
  });

  it('returns each seeded model untouched when no row names it', () => {
    const seeds = [seedModel()];
    const merged = mergeCatalog(seeds, [row({ modelId: 'some-other-model' })], NO_KEYS);
    expect(merged[0]).toBe(seeds[0]);
  });

  it('getAvailableModels with an empty catalog is byte-equal to getAvailableModels with none wired', async () => {
    setModelCatalogProvider(null);
    const withoutCatalog = await getAvailableModels(null);

    setModelCatalogProvider(async () => []);
    const withEmptyCatalog = await getAvailableModels(null);

    expect(withEmptyCatalog).toEqual(withoutCatalog);
    expect(withEmptyCatalog.length).toBeGreaterThan(0);
  });

  afterEach(() => {
    setModelCatalogProvider(null);
    setModelPriceRowsProvider(null);
  });
});

describe('mergeCatalog: per-field-group precedence', () => {
  it('overlays only the groups a discovery row owns and falls through for the rest', () => {
    const seed = seedModel();
    const merged = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          ownedGroups: ['limits'],
          patch: { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
        }),
      ],
      NO_KEYS
    );

    expect(merged[0]).toMatchObject({
      contextWindow: 1_000_000,
      max_tokens: 64_000,
      // untouched groups keep the adapter literal, defaults included
      rank: 5,
      description: 'the seeded description',
      supportsTools: true,
      can_stream: true,
    });
  });

  it('keeps the adapter price literal: a catalog row can never contribute pricing', () => {
    const seed = seedModel();
    const merged = mergeCatalog(
      [seed],
      [row({ modelId: seed.id, ownedGroups: ['limits'], patch: { contextWindow: 200_000 } })],
      NO_KEYS
    );
    expect(merged[0].pricing).toEqual(seed.pricing);
  });

  it('lets an operator patch owning {presentation} survive a discovery change to {limits}', () => {
    const seed = seedModel();
    const merged = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          effectiveFrom: new Date('2026-06-01T00:00:00Z'),
          ownedGroups: ['limits'],
          patch: { contextWindow: 400_000 },
        }),
        row({
          modelId: seed.id,
          source: 'operator',
          // deliberately OLDER than the discovery row: precedence is by source first
          effectiveFrom: new Date('2026-02-01T00:00:00Z'),
          ownedGroups: ['presentation'],
          patch: { rank: 99 },
        }),
      ],
      NO_KEYS
    );

    expect(merged[0].contextWindow).toBe(400_000);
    expect(merged[0].rank).toBe(99);
    // the operator patch is sparse: what it does not name keeps the seeded value
    expect(merged[0].description).toBe('the seeded description');
  });

  it('lets an operator patch owning {limits} survive a discovery change to {presentation}', () => {
    const seed = seedModel();
    const merged = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          effectiveFrom: new Date('2026-06-01T00:00:00Z'),
          ownedGroups: ['presentation'],
          patch: { rank: 1, description: 'discovered description' },
        }),
        row({
          modelId: seed.id,
          source: 'operator',
          effectiveFrom: new Date('2026-02-01T00:00:00Z'),
          ownedGroups: ['limits'],
          patch: { contextWindow: 12_345 },
        }),
      ],
      NO_KEYS
    );

    expect(merged[0].contextWindow).toBe(12_345);
    expect(merged[0].rank).toBe(1);
    expect(merged[0].description).toBe('discovered description');
  });

  it('prefers the newest row within one source tier', () => {
    const seed = seedModel();
    const merged = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          ownedGroups: ['limits'],
          patch: { contextWindow: 1 },
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        }),
        row({
          modelId: seed.id,
          ownedGroups: ['limits'],
          patch: { contextWindow: 2 },
          effectiveFrom: new Date('2026-05-01T00:00:00Z'),
        }),
      ],
      NO_KEYS
    );
    expect(merged[0].contextWindow).toBe(2);
  });

  it('ignores patch keys outside the group the row claims', () => {
    const seed = seedModel();
    const merged = mergeCatalog(
      [seed],
      [row({ modelId: seed.id, ownedGroups: ['presentation'], patch: { rank: 7, contextWindow: 999 } })],
      NO_KEYS
    );
    expect(merged[0].rank).toBe(7);
    expect(merged[0].contextWindow).toBe(128_000);
  });

  it('drives the deprecation filter from catalog lifecycle (the filter relocation)', async () => {
    setModelPriceRowsProvider(null);
    const live = await getAvailableModels(null);
    const target = live.find(m => m.backend === ModelBackend.Bedrock)!;

    setModelCatalogProvider(async () => [
      row({
        modelId: target.id,
        ownedGroups: ['lifecycle'],
        patch: { lifecycle: { status: 'deprecated', deprecationDate: '2020-01-01' } },
      }),
    ]);

    const afterCatalog = await getAvailableModels(null);
    expect(afterCatalog.some(m => m.id === target.id)).toBe(false);
    expect(afterCatalog.length).toBe(live.length - 1);
  });

  it('still filters a seeded model deprecated by its adapter literal when no row touches it', async () => {
    // The relocation must not change the rows-absent semantics: an adapter
    // literal with a past deprecationDate stays hidden either way.
    setModelCatalogProvider(async () => []);
    const models = await getAvailableModels(null);
    expect(models.some(m => m.id === ChatModels.CLAUDE_3_5_SONNET_BEDROCK)).toBe(false);
  });

  afterEach(() => {
    setModelCatalogProvider(null);
    setModelPriceRowsProvider(null);
  });
});

describe('mergeCatalog: catalog-only records and the invocability contract', () => {
  const invocable = {
    id: 'grok-9',
    vendor: 'xai',
    backend: ModelBackend.XAI,
    type: 'text',
    name: 'Grok 9',
    contextWindow: 2_000_000,
    adapterFamily: 'xai',
    dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'chat' },
    lifecycle: { status: 'active' },
  };
  const catalogOnly = (patch: Record<string, unknown>): IModelCatalogRow =>
    row({
      modelId: String(patch.id),
      source: 'discovery',
      ownedGroups: ['identity', 'limits', 'dispatch', 'lifecycle'],
      patch,
    });

  it('emits a record with a dispatchable family, a dispatch profile and a usable backend', () => {
    const { models, dropped, gated } = mergeCatalogWithDrops([], [catalogOnly(invocable)], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
    });

    expect(dropped).toEqual([]);
    expect(gated).toBe(0);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'grok-9', backend: ModelBackend.XAI, contextWindow: 2_000_000 });
    // Never priced from the catalog: the empty map is what trips [UNPRICED_MODEL].
    expect(models[0].pricing).toEqual({});
  });

  it('drops and counts a record whose adapterFamily this build cannot dispatch', () => {
    // voyageai is the one ADAPTER_FAMILIES member with no completion backend.
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly({ ...invocable, adapterFamily: 'voyageai' })], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: expect.stringContaining('voyageai') }]);
  });

  it('emits a bedrock-anthropic record now that family dispatch routes it', () => {
    const { models, dropped } = mergeCatalogWithDrops(
      [],
      [
        catalogOnly({
          ...invocable,
          id: 'global.anthropic.claude-sonnet-9',
          backend: ModelBackend.Bedrock,
          adapterFamily: 'bedrock-anthropic',
        }),
      ],
      { apiKeys: {}, isSelfHost: false }
    );
    expect(dropped).toEqual([]);
    expect(models.map(m => m.id)).toEqual(['global.anthropic.claude-sonnet-9']);
  });

  it('drops and counts a record with no adapterFamily at all', () => {
    const { adapterFamily: _omitted, ...noFamily } = invocable;
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly(noFamily)], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: 'no adapterFamily' }]);
  });

  it('drops and counts a record with no dispatchProfile', () => {
    const { dispatchProfile: _omitted, ...noProfile } = invocable;
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly(noProfile)], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: 'no dispatchProfile' }]);
  });

  it('drops and counts a discovered-but-not-promoted record (metadata-only, never invocable)', () => {
    const { models, dropped } = mergeCatalogWithDrops(
      [],
      [catalogOnly({ ...invocable, lifecycle: { status: 'discovered' } })],
      { apiKeys: { xai: 'xai-key' }, isSelfHost: false }
    );
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: expect.stringContaining('discovered') }]);
  });

  it('drops and counts a record whose type this build does not narrow on', () => {
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly({ ...invocable, type: 'embedding' })], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: 'unsupported model type "embedding"' }]);
  });

  it('drops and counts a record missing fields ModelInfo requires', () => {
    const { vendor: _omitted, ...noVendor } = invocable;
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly({ ...noVendor, contextWindow: 'lots' })], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: 'incomplete record: missing vendor, contextWindow' }]);
  });

  it('gates a catalog-only record on the caller key, exactly as the seeded tier is gated', async () => {
    // One predicate, two tiers: the seeded xAI models come from the backend
    // fan-out and the catalog-only id from the merge, and both must appear and
    // disappear together with apiKeys.xai.
    setModelCatalogProvider(async () => [catalogOnly(invocable)]);

    const withKey = await getAvailableModels({ xai: 'xai-key' });
    expect(withKey.some(m => m.id === 'grok-9')).toBe(true);
    expect(withKey.some(m => m.backend === ModelBackend.XAI && m.id !== 'grok-9')).toBe(true);

    const withoutKey = await getAvailableModels({ xai: null });
    expect(withoutKey.some(m => m.id === 'grok-9')).toBe(false);
    expect(withoutKey.some(m => m.backend === ModelBackend.XAI)).toBe(false);
  });

  it('counts a per-user omission as gated, not as a catalog defect', () => {
    const { models, dropped, gated } = mergeCatalogWithDrops([], [catalogOnly(invocable)], NO_KEYS);
    expect(models).toEqual([]);
    expect(dropped).toEqual([]);
    expect(gated).toBe(1);
  });

  it('emits a catalog-only BFL record with no key at all (the demo-key special case)', () => {
    const { models } = mergeCatalogWithDrops(
      [],
      [
        catalogOnly({
          ...invocable,
          id: 'flux-99',
          vendor: 'black-forest-labs',
          backend: ModelBackend.BFL,
          type: 'image',
          adapterFamily: 'bfl',
        }),
      ],
      NO_KEYS
    );
    expect(models.map(m => m.id)).toEqual(['flux-99']);
  });

  it('never emits a catalog-only voyageai record: this build has no listing backend for it', () => {
    const { models, gated } = mergeCatalogWithDrops(
      [],
      [catalogOnly({ ...invocable, backend: ModelBackend.VoyageAI, adapterFamily: 'xai' })],
      { apiKeys: { voyageai: 'key' }, isSelfHost: false }
    );
    expect(models).toEqual([]);
    expect(gated).toBe(1);
  });

  afterEach(() => {
    setModelCatalogProvider(null);
    setModelPriceRowsProvider(null);
  });
});

describe('mergeCatalog: lenient reads', () => {
  it('ignores a group name this build does not know', () => {
    const seed = seedModel();
    const merged = mergeCatalog(
      [seed],
      [row({ modelId: seed.id, ownedGroups: ['telemetry'], patch: { rank: 42 } })],
      NO_KEYS
    );
    expect(merged[0].rank).toBe(5);
  });

  it('ranks an unrecognized source below every known one but still lets it contribute', () => {
    const seed = seedModel();
    const [onlyImport] = mergeCatalog(
      [seed],
      [row({ modelId: seed.id, source: 'import', ownedGroups: ['presentation'], patch: { rank: 42 } })],
      NO_KEYS
    );
    expect(onlyImport.rank).toBe(42);

    const [seedWins] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'import',
          effectiveFrom: new Date('2026-09-01T00:00:00Z'),
          ownedGroups: ['presentation'],
          patch: { rank: 42 },
        }),
        row({
          modelId: seed.id,
          source: 'seed',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          ownedGroups: ['presentation'],
          patch: { rank: 8 },
        }),
      ],
      NO_KEYS
    );
    expect(seedWins.rank).toBe(8);
  });

  it('keeps a seeded model on its adapter record when a row makes the merge unrenderable', () => {
    // A feed reclassifying `type` must cost the row, not a working model: the
    // seeded tier has a known-good base, unlike a catalog-only id.
    const seed = seedModel();
    const { models, dropped } = mergeCatalogWithDrops(
      [seed],
      [row({ modelId: seed.id, ownedGroups: ['identity'], patch: { type: 'video-preview' } })],
      NO_KEYS
    );

    expect(models).toEqual([seed]);
    expect(dropped).toEqual([
      { modelId: seed.id, reason: expect.stringContaining('unsupported model type "video-preview"') },
    ]);
  });

  it('strips {dispatch} from a seeded model when a row names a family this build cannot dispatch', () => {
    // The catalog-only tier gets this from invocabilityBlocker. getLlmByModel
    // routes on adapterFamily and backendForAdapterFamily THROWS on a family it
    // has no constructor for, so the seeded tier needs the same guard - minus
    // the active-lifecycle clause, which would strip dispatch off every legacy
    // but still-served seeded model.
    const seed = seedModel();
    const { models, dropped } = mergeCatalogWithDrops(
      [seed],
      [
        row({
          modelId: seed.id,
          ownedGroups: ['dispatch', 'presentation'],
          patch: {
            adapterFamily: 'openai-conversations',
            dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'chat' },
            rank: 9,
          },
        }),
      ],
      NO_KEYS
    );

    expect(models[0].adapterFamily).toBeUndefined();
    expect(models[0].dispatchProfile).toBeUndefined();
    // Only that one group is dropped; the rest of the row still applies.
    expect(models[0].rank).toBe(9);
    expect(dropped).toEqual([
      { modelId: seed.id, reason: expect.stringContaining('"openai-conversations" is not dispatchable') },
    ]);
  });

  it('keeps {dispatch} on a seeded model whose row names a family this build does dispatch', () => {
    const seed = seedModel();
    const { models, dropped } = mergeCatalogWithDrops(
      [seed],
      [
        row({
          modelId: seed.id,
          ownedGroups: ['dispatch'],
          patch: {
            adapterFamily: 'openai-responses',
            dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'responses' },
          },
        }),
      ],
      NO_KEYS
    );

    expect(models[0].adapterFamily).toBe('openai-responses');
    expect(models[0].dispatchProfile).toEqual({
      maxTokensParam: 'max_completion_tokens',
      toolTransport: 'responses',
    });
    expect(dropped).toEqual([]);
  });

  it('round-trips a seeded model through toModelRecord without losing what a row does not own', () => {
    const seed = seedModel();
    const record = toModelRecord(seed);
    const merged = mergeCatalog(
      [seed],
      [row({ modelId: seed.id, ownedGroups: ['identity'], patch: { name: 'renamed' } })],
      NO_KEYS
    );
    expect(record.maxOutputTokens).toBe(seed.max_tokens);
    expect(merged[0].name).toBe('renamed');
    expect(merged[0].max_tokens).toBe(seed.max_tokens);
  });
});
