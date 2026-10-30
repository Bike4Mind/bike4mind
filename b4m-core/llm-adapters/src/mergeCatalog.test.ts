import { describe, it, expect, afterEach } from 'vitest';
import { ChatModels, ImageModels, ModelBackend, toModelRecord } from '@bike4mind/common';
import type { IModelCatalogRow, ModelInfo } from '@bike4mind/common';
import { getAvailableModels, setModelCatalogProvider, setModelPriceRowsProvider } from './index';
import { mergeCatalog, mergeCatalogWithDrops, resolveCatalogRecords } from './mergeCatalog';
import type { BackendGateContext } from './backendGate';

const NO_KEYS: BackendGateContext = { apiKeys: null, isSelfHost: false, bedrockReachable: true };

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

  /**
   * The seeded tier states a real cap, so its ModelInfo is declared by omission of the flag.
   * A {limits} row that says nothing about the cap must not turn it derived: mergeRows carries
   * the seeded value forward, so the read path still has data rather than toModelInfo's default.
   */
  it('keeps a seeded cap declared through a {limits} row that omits one', () => {
    const seed = seedModel();
    expect(seed.maxOutputTokensDerived).toBeUndefined();

    const merged = mergeCatalog(
      [seed],
      [row({ modelId: seed.id, ownedGroups: ['limits'], patch: { contextWindow: 1_000_000 } })],
      NO_KEYS
    );
    expect(merged[0]).toMatchObject({ contextWindow: 1_000_000, max_tokens: seed.max_tokens });
    expect(merged[0].maxOutputTokensDerived).toBeUndefined();
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

  it('ranks a seed row above discovery for {presentation} only', () => {
    const rows = [
      row({
        modelId: 'gpt-6-sol',
        source: 'discovery',
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
        ownedGroups: ['limits', 'presentation'],
        patch: { contextWindow: 400_000, releaseDate: '2026-09-01' },
      }),
      row({
        modelId: 'gpt-6-sol',
        source: 'seed',
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
        ownedGroups: ['limits', 'presentation'],
        patch: { contextWindow: 272_000, description: 'Seeded copy.', releaseDate: '2026-08-15' },
      }),
    ];

    expect(resolveCatalogRecords(rows).get('gpt-6-sol')?.record).toMatchObject({
      contextWindow: 400_000,
      description: 'Seeded copy.',
      releaseDate: '2026-08-15',
    });
  });

  it('ranks operator over seed over discovery for {presentation} in one bucket', () => {
    const presenting = (source: string, rank: number) =>
      row({ modelId: 'gpt-6-sol', source, ownedGroups: ['presentation'], patch: { rank } });

    const resolve = (rows: IModelCatalogRow[]) => resolveCatalogRecords(rows).get('gpt-6-sol')?.record.rank;

    expect(resolve([presenting('discovery', 1), presenting('seed', 2), presenting('operator', 3)])).toBe(3);
    expect(resolve([presenting('operator', 3), presenting('discovery', 1), presenting('seed', 2)])).toBe(3);
    expect(resolve([presenting('discovery', 1), presenting('seed', 2)])).toBe(2);
    expect(resolve([presenting('seed', 2), presenting('discovery', 1)])).toBe(2);
  });

  it('keeps the adapter literal presentation under a discovery row that owns only releaseDate', () => {
    const seed = seedModel({ logoFile: 'openai.svg', releaseDate: '2025-04-14' });
    const merged = mergeCatalogWithDrops(
      [seed],
      [row({ modelId: seed.id, ownedGroups: ['presentation'], patch: { releaseDate: '2026-09-01' } })],
      NO_KEYS
    ).models;

    // The literal is the merge base, so the row overrides only the key it carries.
    expect(merged[0]).toMatchObject({
      description: 'the seeded description',
      rank: 5,
      logoFile: 'openai.svg',
      releaseDate: '2026-09-01',
    });
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
      bedrockReachable: true,
    });

    expect(dropped).toEqual([]);
    expect(gated).toBe(0);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'grok-9', backend: ModelBackend.XAI, contextWindow: 2_000_000 });
    // Never priced from the catalog: the empty map is what trips [UNPRICED_MODEL].
    expect(models[0].pricing).toEqual({});
  });

  it('marks a catalog-only record that declares no cap as derived', () => {
    const { models } = mergeCatalogWithDrops([], [catalogOnly(invocable)], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
    });
    expect(models[0]).toMatchObject({ max_tokens: 4096, maxOutputTokensDerived: true });

    const { models: declared } = mergeCatalogWithDrops([], [catalogOnly({ ...invocable, maxOutputTokens: 32_000 })], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
    });
    expect(declared[0].max_tokens).toBe(32_000);
    expect(declared[0].maxOutputTokensDerived).toBeUndefined();
  });

  it('drops and counts a record whose adapterFamily this build cannot dispatch', () => {
    // voyageai is the one ADAPTER_FAMILIES member with no completion backend.
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly({ ...invocable, adapterFamily: 'voyageai' })], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
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
      { apiKeys: {}, isSelfHost: false, bedrockReachable: true }
    );
    expect(dropped).toEqual([]);
    expect(models.map(m => m.id)).toEqual(['global.anthropic.claude-sonnet-9']);
  });

  it.each([
    'deep-research-preview-04-2026',
    'deep-research-max-preview-04-2026',
    'gemini-2.5-computer-use-preview-10-2025',
  ])('drops %s as needing a dedicated API, and lists its normal sibling', id => {
    const ctx = { apiKeys: { gemini: 'gemini-key' }, isSelfHost: false, bedrockReachable: true };
    const gemini = {
      ...invocable,
      vendor: 'google',
      backend: ModelBackend.Gemini,
      adapterFamily: 'gemini',
      type: 'text',
    };
    const { models, dropped } = mergeCatalogWithDrops(
      [],
      [
        catalogOnly({ ...gemini, id, name: 'Agentic' }),
        catalogOnly({ ...gemini, id: 'gemini-9-flash', name: 'Gemini 9 Flash' }),
      ],
      ctx
    );
    expect(models.map(m => m.id)).toEqual(['gemini-9-flash']);
    expect(dropped).toEqual([
      {
        modelId: id,
        reason: 'needs a dedicated API or a mandatory tool; not callable as a plain text model',
      },
    ]);
  });

  it('keeps a seeded model whose id matches the dedicated-API pattern (the seeded tier skips the blocker)', () => {
    const seed = seedModel({ id: 'o3-deep-research', name: 'o3 Deep Research' });
    const { models, dropped } = mergeCatalogWithDrops([seed], [row({ modelId: seed.id })], NO_KEYS);
    expect(models.map(m => m.id)).toEqual([seed.id]);
    expect(dropped).toEqual([]);
  });

  it('drops and counts a record with no adapterFamily at all', () => {
    const { adapterFamily: _omitted, ...noFamily } = invocable;
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly(noFamily)], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: 'no adapterFamily' }]);
  });

  it('drops and counts a record with no dispatchProfile', () => {
    const { dispatchProfile: _omitted, ...noProfile } = invocable;
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly(noProfile)], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: 'no dispatchProfile' }]);
  });

  it('drops and counts a discovered-but-not-promoted record (metadata-only, never invocable)', () => {
    const { models, dropped } = mergeCatalogWithDrops(
      [],
      [catalogOnly({ ...invocable, lifecycle: { status: 'discovered' } })],
      { apiKeys: { xai: 'xai-key' }, isSelfHost: false, bedrockReachable: true }
    );
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: expect.stringContaining('discovered') }]);
  });

  it('drops a discovered record with no claimed context window on the lifecycle reason, not incomplete-record', () => {
    // Discovery writes a bare identity+lifecycle row before an aggregator join
    // supplies a context window; that row must read as "not yet promoted", not
    // as a malformed record.
    const discoveredRow = row({
      modelId: 'gpt-6-astra',
      source: 'discovery',
      ownedGroups: ['identity', 'lifecycle'],
      patch: {
        id: 'gpt-6-astra',
        vendor: 'openai',
        backend: ModelBackend.OpenAI,
        type: 'text',
        name: 'GPT 6 Astra',
        lifecycle: { status: 'discovered' },
      },
    });
    const { models, dropped } = mergeCatalogWithDrops([], [discoveredRow], NO_KEYS);
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'gpt-6-astra', reason: expect.stringContaining('discovered') }]);
    expect(dropped[0].reason).not.toContain('incomplete record');
  });

  it('drops and counts a record whose type this build does not narrow on', () => {
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly({ ...invocable, type: 'embedding' })], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
    });
    expect(models).toEqual([]);
    expect(dropped).toEqual([{ modelId: 'grok-9', reason: 'unsupported model type "embedding"' }]);
  });

  it('drops and counts a record missing fields ModelInfo requires', () => {
    const { vendor: _omitted, ...noVendor } = invocable;
    const { models, dropped } = mergeCatalogWithDrops([], [catalogOnly({ ...noVendor, contextWindow: 'lots' })], {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
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

  it('gates a catalog-only BFL record behind a real BFL key, like every other keyed backend', () => {
    const fluxRow = catalogOnly({
      ...invocable,
      id: 'flux-99',
      vendor: 'black-forest-labs',
      backend: ModelBackend.BFL,
      type: 'image',
      adapterFamily: 'bfl',
    });

    expect(mergeCatalogWithDrops([], [fluxRow], NO_KEYS).models).toEqual([]);
    expect(
      mergeCatalogWithDrops([], [fluxRow], {
        apiKeys: { bfl: 'k' },
        isSelfHost: false,
        bedrockReachable: true,
      }).models.map(m => m.id)
    ).toEqual(['flux-99']);
  });

  it('never emits a catalog-only voyageai record: this build has no listing backend for it', () => {
    const { models, gated } = mergeCatalogWithDrops(
      [],
      [catalogOnly({ ...invocable, backend: ModelBackend.VoyageAI, adapterFamily: 'xai' })],
      { apiKeys: { voyageai: 'key' }, isSelfHost: false, bedrockReachable: true }
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

describe('mergeCatalog: a non-operator lifecycle only moves toward sunset', () => {
  const earlier = { status: 'deprecated', deprecationDate: '2026-09-02' };
  const lifecycleRow = (
    modelId: string,
    source: string,
    lifecycle: Record<string, unknown>,
    effectiveFrom = new Date('2026-01-01T00:00:00Z')
  ) => row({ modelId, source, ownedGroups: ['lifecycle'], patch: { lifecycle }, effectiveFrom });
  const lifecycleOf = (rows: IModelCatalogRow[]) => resolveCatalogRecords(rows).get(rows[0].modelId)?.record.lifecycle;

  afterEach(() => {
    setModelCatalogProvider(null);
    setModelPriceRowsProvider(null);
  });

  it('keeps an adapter superseded marker when discovery only reports an active status', () => {
    const seed = seedModel({ isSuperseded: true });
    const [merged] = mergeCatalog([seed], [lifecycleRow(seed.id, 'discovery', { status: 'active' })], NO_KEYS);
    expect(merged.isSuperseded).toBe(true);
    expect(merged.disabled).toBeFalsy();
  });

  it('keeps seeded superseded metadata over discovery but lets an operator clear it', () => {
    const seed = seedModel();
    const rows = [
      lifecycleRow(seed.id, 'seed', { status: 'active', isSuperseded: true }),
      lifecycleRow(seed.id, 'discovery', { status: 'active', isSuperseded: false }),
    ];
    expect(mergeCatalog([seed], rows, NO_KEYS)[0].isSuperseded).toBe(true);
    expect(
      mergeCatalog(
        [seed],
        [...rows, lifecycleRow(seed.id, 'operator', { status: 'active', isSuperseded: false })],
        NO_KEYS
      )[0].isSuperseded
    ).toBe(false);
  });

  it('keeps a past adapter-literal deprecation hidden when discovery reports it active with a later date', async () => {
    setModelPriceRowsProvider(null);
    setModelCatalogProvider(async () => []);
    const baseline = await getAvailableModels(null);

    setModelCatalogProvider(async () => [
      lifecycleRow(ChatModels.CLAUDE_3_5_SONNET_BEDROCK, 'discovery', {
        status: 'active',
        deprecationDate: '2099-01-01',
      }),
    ]);
    const models = await getAvailableModels(null);
    expect(models.some(m => m.id === ChatModels.CLAUDE_3_5_SONNET_BEDROCK)).toBe(false);
    // Positive control: the filter dropped nothing else and let nothing in, so the absence above is the fold's doing.
    expect(baseline.length).toBeGreaterThan(0);
    expect(models.map(m => m.id)).toEqual(baseline.map(m => m.id));
  });

  it('keeps the adapter-literal date over a later discovery date', () => {
    const seed = seedModel({ deprecationDate: '2020-01-01' });
    const [merged] = mergeCatalog(
      [seed],
      [lifecycleRow(seed.id, 'discovery', { status: 'active', deprecationDate: '2099-01-01' })],
      NO_KEYS
    );
    expect(merged.deprecationDate).toBe('2020-01-01');
  });

  it.each([
    {
      name: 'keeps the seed date and status over a discovery active with a later date',
      seed: earlier,
      discovery: { status: 'active', deprecationDate: '2026-10-20' },
      expected: earlier,
    },
    {
      name: 'lets an earlier discovery date beat a later seed date',
      seed: { status: 'deprecated', deprecationDate: '2026-12-01' },
      discovery: { status: 'deprecated', deprecationDate: '2026-09-02' },
      expected: earlier,
    },
    {
      name: 'folds retirementDate to the earliest as well',
      seed: { status: 'deprecated', retirementDate: '2026-11-01' },
      discovery: { status: 'deprecated', retirementDate: '2026-12-01' },
      expected: { status: 'deprecated', retirementDate: '2026-11-01' },
    },
    {
      name: 'keeps a seeded retired status over a discovery active',
      seed: { status: 'retired' },
      discovery: { status: 'active' },
      expected: { status: 'retired' },
    },
    {
      name: 'never lets an unranked status displace a ranked winner',
      seed: { status: 'unlisted' },
      discovery: { status: 'active' },
      expected: { status: 'active' },
    },
    {
      name: 'keeps an unranked winner against an active seed',
      seed: { status: 'active' },
      discovery: { status: 'unlisted' },
      expected: { status: 'unlisted' },
    },
    {
      name: 'lets a sunset seed displace an unranked winner',
      seed: { status: 'legacy' },
      discovery: { status: 'unlisted' },
      expected: { status: 'legacy' },
    },
    {
      name: 'keeps an unknown winner status the same way',
      seed: { status: 'active' },
      discovery: { status: 'some-future-status' },
      expected: { status: 'some-future-status' },
    },
    {
      name: 'fills a status the winner left out from the other sources, and keeps its dates',
      seed: { status: 'active' },
      discovery: { deprecationDate: '2026-09-02' },
      expected: { status: 'active', deprecationDate: '2026-09-02' },
    },
    {
      name: 'keeps the winning row replacedBy',
      seed: { status: 'deprecated', replacedBy: 'old-successor' },
      discovery: { status: 'deprecated', replacedBy: 'new-successor' },
      expected: { status: 'deprecated', replacedBy: 'new-successor' },
    },
  ])('$name', ({ seed, discovery, expected }) => {
    const rows = [lifecycleRow('gpt-6-sol', 'seed', seed), lifecycleRow('gpt-6-sol', 'discovery', discovery)];
    expect(lifecycleOf(rows)).toEqual(expected);
  });

  it('still folds the lifecycle when an operator row owns only {availability}', () => {
    const rows = [
      lifecycleRow('gpt-6-sol', 'seed', earlier),
      lifecycleRow('gpt-6-sol', 'discovery', { status: 'active', deprecationDate: '2026-10-20' }),
      row({
        modelId: 'gpt-6-sol',
        source: 'operator',
        ownedGroups: ['availability'],
        patch: { disabled: false },
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      }),
    ];
    expect(lifecycleOf(rows)).toEqual(earlier);
  });

  it('applies an operator lifecycle as-is: marking a deprecated model active with no date un-deprecates it', () => {
    const seed = seedModel({ deprecationDate: '2020-01-01' });
    const rows = [
      lifecycleRow(seed.id, 'seed', earlier),
      lifecycleRow(seed.id, 'operator', { status: 'active' }, new Date('2026-06-01T00:00:00Z')),
    ];
    expect(lifecycleOf(rows)).toEqual({ status: 'active' });
    expect(mergeCatalog([seed], rows, NO_KEYS)[0].deprecationDate).toBeUndefined();
  });

  it('still promotes a catalog-only record: seed discovered, discovery active', () => {
    const invocable = {
      id: 'grok-9',
      vendor: 'xai',
      backend: ModelBackend.XAI,
      type: 'text',
      name: 'Grok 9',
      contextWindow: 2_000_000,
      adapterFamily: 'xai',
      dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'chat' },
    };
    const rows = [
      row({
        modelId: 'grok-9',
        source: 'seed',
        ownedGroups: ['identity', 'limits', 'dispatch', 'lifecycle'],
        patch: { ...invocable, lifecycle: { status: 'discovered' } },
      }),
      lifecycleRow('grok-9', 'discovery', { status: 'active' }),
    ];
    const { models, dropped } = mergeCatalogWithDrops([], rows, {
      apiKeys: { xai: 'xai-key' },
      isSelfHost: false,
      bedrockReachable: true,
    });
    expect(dropped).toEqual([]);
    expect(models.map(m => m.id)).toEqual(['grok-9']);
  });

  it('leaves a record no row gives a lifecycle untouched', () => {
    const rows = [row({ modelId: 'gpt-6-sol', ownedGroups: ['limits'], patch: { contextWindow: 9 } })];
    expect(lifecycleOf(rows)).toBeUndefined();
  });
});

describe('mergeCatalog: a non-operator availability row cannot clear a disable', () => {
  const availabilityRow = (
    modelId: string,
    source: string,
    patch: Record<string, unknown>,
    effectiveFrom = new Date('2026-01-01T00:00:00Z')
  ) => row({ modelId, source, ownedGroups: ['availability'], patch, effectiveFrom });

  it('keeps an adapter-literal disable under a seed row that says disabled false', () => {
    const seed = seedModel({ disabled: true, disabledReason: 'literal reason' });
    const [merged] = mergeCatalog([seed], [availabilityRow(seed.id, 'seed', { disabled: false })], NO_KEYS);
    expect(merged).toMatchObject({ disabled: true, disabledReason: 'literal reason' });
  });

  it('lets an operator row with disabled false clear it', () => {
    const seed = seedModel({ disabled: true, disabledReason: 'literal reason' });
    const [merged] = mergeCatalog(
      [seed],
      [
        availabilityRow(seed.id, 'seed', { disabled: false }),
        availabilityRow(seed.id, 'operator', { disabled: false }, new Date('2026-06-01T00:00:00Z')),
      ],
      NO_KEYS
    );
    expect(merged.disabled).toBe(false);
  });

  it('takes the reason from the highest-precedence disabling row, whatever the bucket order', () => {
    const seed = seedModel();
    const rows = [
      availabilityRow(seed.id, 'seed', { disabled: true, disabledReason: 'seed reason' }),
      availabilityRow(seed.id, 'import', { disabled: true, disabledReason: 'import reason' }),
      availabilityRow(seed.id, 'discovery', { disabled: false }),
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const [merged] = mergeCatalog([seed], ordered, NO_KEYS);
      expect(merged).toMatchObject({ disabled: true, disabledReason: 'seed reason' });
    }
  });

  it('does not leave the winner reason next to a disable another row put there', () => {
    const seed = seedModel();
    const [merged] = mergeCatalog(
      [seed],
      [
        availabilityRow(seed.id, 'seed', { disabled: true }),
        availabilityRow(seed.id, 'discovery', { disabled: false, disabledReason: 'stale winner reason' }),
      ],
      NO_KEYS
    );
    expect(merged.disabled).toBe(true);
    expect(merged.disabledReason).toBeUndefined();
  });

  it('does not leave the winner reason next to an adapter-literal disable either', () => {
    const seed = seedModel({ disabled: true });
    const [merged] = mergeCatalog(
      [seed],
      [availabilityRow(seed.id, 'seed', { disabled: false, disabledReason: 'stale winner reason' })],
      NO_KEYS
    );
    expect(merged.disabled).toBe(true);
    expect(merged.disabledReason).toBeUndefined();
  });

  it('keeps a lower-ranked seed disable, with its reason, under a discovery row that says disabled false', () => {
    const seed = seedModel();
    const [merged] = mergeCatalog(
      [seed],
      [
        availabilityRow(seed.id, 'seed', { disabled: true, disabledReason: 'seed reason' }),
        availabilityRow(seed.id, 'discovery', { disabled: false }),
      ],
      NO_KEYS
    );
    expect(merged).toMatchObject({ disabled: true, disabledReason: 'seed reason' });
  });

  it('does not touch autoDisabled: a discovery promotion still clears it', () => {
    const seed = seedModel();
    const [merged] = mergeCatalog(
      [seed],
      [
        availabilityRow(seed.id, 'seed', { autoDisabled: true }),
        availabilityRow(seed.id, 'discovery', { autoDisabled: false }),
      ],
      NO_KEYS
    );
    expect(merged.disabled).toBe(false);
  });
});

describe('mergeCatalog: a discovery introduction under a curated record', () => {
  const imageSeed = (overrides: Partial<ModelInfo> = {}): ModelInfo =>
    seedModel({
      id: ImageModels.FLUX_2_PRO,
      type: 'image',
      name: 'FLUX.2 Pro',
      backend: ModelBackend.BFL,
      contextWindow: 10_000,
      supportsImageVariation: true,
      ...overrides,
    });

  /** What the writer produced for an endpoint no adapter table curated: slug, 0, disabled. */
  const introduction = (overrides: Partial<IModelCatalogRow> = {}): IModelCatalogRow =>
    row({
      modelId: String(ImageModels.FLUX_2_PRO),
      source: 'discovery',
      ownedGroups: ['identity', 'limits', 'availability', 'lifecycle'],
      patch: {
        id: String(ImageModels.FLUX_2_PRO),
        vendor: 'black-forest-labs',
        backend: ModelBackend.BFL,
        type: 'image',
        name: String(ImageModels.FLUX_2_PRO),
        contextWindow: 0,
        autoDisabled: true,
        autoDisabledReason: 'discovered, not invocable by this build',
        lifecycle: { status: 'discovered' },
      },
      ...overrides,
    });

  it('yields the name, the window and the disable to the curated record', () => {
    const seed = imageSeed();
    const [merged] = mergeCatalog([seed], [introduction()], NO_KEYS);

    expect(merged).toMatchObject({ name: 'FLUX.2 Pro', contextWindow: 10_000 });
    expect(merged.disabled).toBeFalsy();
    expect(merged.disabledReason).toBeUndefined();
  });

  it('yields from a snapshot of the introduction that claims no lifecycle', () => {
    const seed = imageSeed();
    // A snapshot carries forward only the groups it re-decides: discovery's own disable, not
    // lifecycle or limits. The name is one a feed supplied rather than the id the writer pins, so
    // the id-for-a-name clause cannot apply and the flag alone has to say it is still an introduction.
    // Production's snapshot for these ids also claims lifecycle (see the discovery suite's next-run
    // case, which pins that shape).
    const [merged] = mergeCatalog(
      [seed],
      [
        introduction({
          ownedGroups: ['identity', 'availability'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            name: 'FLUX.2 Pro [feed]',
            autoDisabled: true,
            autoDisabledReason: 'discovered, not invocable by this build',
          },
        }),
      ],
      NO_KEYS
    );

    expect(merged).toMatchObject({ name: 'FLUX.2 Pro', contextWindow: 10_000 });
    expect(merged.disabled).toBeFalsy();
  });

  it('keeps a provider-declared disable while the curated record supplies the identity', () => {
    const seed = imageSeed();
    // How the Bedrock source reports an unentitled model: a real name, the provider's own reason.
    const [merged] = mergeCatalog(
      [seed],
      [
        introduction({
          ownedGroups: ['identity', 'limits', 'availability', 'lifecycle'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            name: 'FLUX.2 Pro [prov]',
            contextWindow: 8_000,
            autoDisabled: true,
            autoDisabledReason: 'not entitled in this AWS account',
            lifecycle: { status: 'discovered' },
          },
        }),
      ],
      NO_KEYS
    );

    expect(merged).toMatchObject({
      name: 'FLUX.2 Pro',
      contextWindow: 10_000,
      disabled: true,
      disabledReason: 'not entitled in this AWS account',
    });
  });

  it('still lets a promoted discovery row claim the groups it owns', () => {
    const seed = imageSeed();
    // The row promotion writes: the whole introduction carried forward, with autoDisabled false.
    // A feed that names models by id (Ollama), or one the writer pinned the slug for, keeps that
    // name through promotion - so the name alone cannot say the row is still an introduction.
    const [merged] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          ownedGroups: ['limits'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            name: String(ImageModels.FLUX_2_PRO),
            contextWindow: 400_000,
            autoDisabled: false,
            lifecycle: { status: 'active' },
          },
        }),
      ],
      NO_KEYS
    );

    expect(merged.contextWindow).toBe(400_000);
  });

  it('yields the pinned id as a name from a promoted row, keeping the window it measured', () => {
    const seed = imageSeed();
    // Promotion clears autoDisabled but keeps the name the writer pinned for a feed that published
    // none - the model id. Identity has to yield to the curated label while limits stays the row's.
    const [merged] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          ownedGroups: ['identity', 'limits'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            name: String(ImageModels.FLUX_2_PRO),
            contextWindow: 400_000,
            autoDisabled: false,
            lifecycle: { status: 'active' },
          },
        }),
      ],
      NO_KEYS
    );

    expect(merged).toMatchObject({ name: 'FLUX.2 Pro', contextWindow: 400_000 });
  });

  it('keeps a measured window on a row a source has since disabled, and the disable', () => {
    const seed = imageSeed();
    // The window is not the introduction's zero: an aggregator joined it, or the source measured it.
    // Curation keeps the disable (the provider's answer) but has no better window to offer.
    const [merged] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          ownedGroups: ['identity', 'limits', 'availability', 'lifecycle'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            name: 'FLUX.2 Pro',
            contextWindow: 400_000,
            autoDisabled: true,
            autoDisabledReason: 'not entitled in this AWS account',
            lifecycle: { status: 'active' },
          },
        }),
      ],
      NO_KEYS
    );

    expect(merged).toMatchObject({
      contextWindow: 400_000,
      disabled: true,
      disabledReason: 'not entitled in this AWS account',
    });
  });

  it('reclaims from a row written before autoDisabled was carried forward', () => {
    const seed = imageSeed();
    // The build before the flag existed wrote no autoDisabled anywhere; the lifecycle alone says
    // discovery never promoted this row.
    const [merged] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          ownedGroups: ['identity', 'limits', 'lifecycle'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            name: String(ImageModels.FLUX_2_PRO),
            contextWindow: 0,
            lifecycle: { status: 'discovered' },
          },
        }),
      ],
      NO_KEYS
    );

    expect(merged).toMatchObject({ name: 'FLUX.2 Pro', contextWindow: 10_000 });
  });

  it('reclaims an availability group the row credits to discovery but states no reason for', () => {
    const seed = imageSeed();
    // A row written before the verdict wording existed: the contributor credit is the only evidence
    // of who disabled the model.
    const [merged] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          ownedGroups: ['availability'],
          patch: { autoDisabled: true },
          contributors: [{ group: 'availability', source: 'discovery' }],
        }),
      ],
      NO_KEYS
    );

    expect(merged.disabled).toBeFalsy();
  });

  it('keeps a disable the row credits to the provider even when the reason wears discovery wording', () => {
    const seed = imageSeed();
    // The row a writer that credited a group to whoever supplied its first field leaves when one run
    // both clears the provider's disable and has its promotion refused: the disable in force is
    // discovery's verdict, but the clearance supplied `autoDisabled`, so the row credits the
    // provider. That row cannot be told from the one main's writer left by restamping a provider
    // disable to a verdict, and the contributor is what the read path trusts - so it keeps its
    // disable until a run that decides the disable itself re-credits it (a run with no availability
    // answer keeps the credit). The contributor, not the wording, says who disabled it.
    const [merged] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          ownedGroups: ['availability', 'lifecycle'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            autoDisabled: true,
            autoDisabledReason: 'discovered, awaiting admin approval',
            lifecycle: { status: 'discovered' },
          },
          contributors: [{ group: 'availability', source: 'bedrock' }],
        }),
      ],
      NO_KEYS
    );

    expect(merged).toMatchObject({ disabled: true, disabledReason: 'discovered, awaiting admin approval' });
  });

  it('reclaims a verdict disable the row credits to discovery', () => {
    const seed = imageSeed();
    // The other side of the contributor test: discovery's own refusal still yields to curation.
    const [merged] = mergeCatalog(
      [seed],
      [
        row({
          modelId: seed.id,
          source: 'discovery',
          ownedGroups: ['availability', 'lifecycle'],
          patch: {
            id: String(ImageModels.FLUX_2_PRO),
            vendor: 'black-forest-labs',
            backend: ModelBackend.BFL,
            type: 'image',
            autoDisabled: true,
            autoDisabledReason: 'discovered, awaiting price',
            lifecycle: { status: 'discovered' },
          },
          contributors: [{ group: 'availability', source: 'discovery' }],
        }),
      ],
      NO_KEYS
    );

    expect(merged.disabled).toBeFalsy();
  });
});
