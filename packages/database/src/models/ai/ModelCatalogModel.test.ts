import { describe, it, expect, beforeEach } from 'vitest';
import { CATALOG_SCHEMA_VERSION, ChatModels, IModelCatalogRowInput, ModelBackend } from '@bike4mind/common';
import type { ModelInfo } from '@bike4mind/common';
import { mergeCatalog } from '@bike4mind/llm-adapters';
import { ModelCatalog, modelCatalogRepository } from './ModelCatalogModel';
import { setupMongoTest } from '../../__test__/utils';

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'gpt-x',
  vendor: 'openai',
  backend: ModelBackend.OpenAI,
  type: 'text' as const,
  name: 'GPT X',
  contextWindow: 128_000,
  ...overrides,
});

const snapshot = (overrides: Partial<IModelCatalogRowInput> = {}): IModelCatalogRowInput =>
  ({
    modelId: 'gpt-x',
    source: 'discovery',
    ownedGroups: ['identity', 'limits'],
    patch: record(),
    effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  }) as IModelCatalogRowInput;

describe('ModelCatalogRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ModelCatalog.deleteMany({});
    await ModelCatalog.ensureIndexes();
  });

  it('stamps the schema version and round-trips a row', async () => {
    await modelCatalogRepository.append(snapshot({ note: 'first sighting' }));

    const [row] = await modelCatalogRepository.rowsInForce(new Date('2026-07-15T00:00:00Z'));
    expect(row.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(row.patch).toMatchObject({ id: 'gpt-x', contextWindow: 128_000 });
    expect(row.ownedGroups).toEqual(['identity', 'limits']);
    expect(row.note).toBe('first sighting');
  });

  it('rejects an invalid row instead of persisting it', async () => {
    await expect(
      modelCatalogRepository.append(
        snapshot({ patch: record({ pricing: { '0': { input: 1, output: 2 } } }) } as Partial<IModelCatalogRowInput>)
      )
    ).rejects.toThrow();
    expect(await ModelCatalog.countDocuments({})).toBe(0);
  });

  it('collapses a source to its newest row, ignores future-dated rows, and time-travels', async () => {
    await modelCatalogRepository.append(snapshot({ effectiveFrom: new Date('2026-06-01T00:00:00Z'), note: 'june' }));
    await modelCatalogRepository.append(snapshot({ effectiveFrom: new Date('2026-07-01T00:00:00Z'), note: 'july' }));
    await modelCatalogRepository.append(snapshot({ effectiveFrom: new Date('2026-08-01T00:00:00Z'), note: 'august' }));
    await modelCatalogRepository.append(
      snapshot({
        modelId: 'claude-y',
        patch: record({ id: 'claude-y', vendor: 'anthropic', backend: ModelBackend.Anthropic, name: 'Claude Y' }),
        effectiveFrom: new Date('2026-06-15T00:00:00Z'),
      })
    );

    const rows = await modelCatalogRepository.rowsInForce(new Date('2026-07-15T00:00:00Z'));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.modelId === 'gpt-x')?.note).toBe('july');

    const earlier = await modelCatalogRepository.rowsInForce(new Date('2026-06-20T00:00:00Z'));
    expect(earlier.find(row => row.modelId === 'gpt-x')?.note).toBe('june');
  });

  it('treats a concurrent identical append as a skip, not an error', async () => {
    const results = await Promise.all([
      modelCatalogRepository.append(snapshot()),
      modelCatalogRepository.append(snapshot()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(result => result === null)).toHaveLength(1);
    expect(await ModelCatalog.countDocuments({ modelId: 'gpt-x' })).toBe(1);
  });

  it('reads a v1 row under a newer schema and a newer row under this one', async () => {
    // Written by an older build: no fields this version added, older schemaVersion.
    await ModelCatalog.create({
      modelId: 'gpt-old',
      schemaVersion: CATALOG_SCHEMA_VERSION,
      source: 'seed',
      ownedGroups: ['identity'],
      patch: record({ id: 'gpt-old', name: 'GPT Old' }),
      effectiveFrom: new Date('2026-05-01T00:00:00Z'),
    });
    // Written by a newer build: unknown row and patch fields, unknown enum values.
    await ModelCatalog.create({
      modelId: 'gpt-new',
      schemaVersion: CATALOG_SCHEMA_VERSION + 1,
      source: 'discovery',
      ownedGroups: ['identity', 'holography'],
      patch: record({ id: 'gpt-new', name: 'GPT New', type: 'holograph', quantizationProfile: 'q8' }),
      effectiveFrom: new Date('2026-05-02T00:00:00Z'),
      provenanceV2: 'kept',
    });

    const rows = await modelCatalogRepository.rowsInForce(new Date('2026-06-01T00:00:00Z'));
    expect(rows.map(row => row.modelId).sort()).toEqual(['gpt-new', 'gpt-old']);
    const forward = rows.find(row => row.modelId === 'gpt-new');
    expect(forward?.patch).toMatchObject({ type: 'holograph', quantizationProfile: 'q8' });
  });

  it('drops only the corrupt row and surfaces the count', async () => {
    await modelCatalogRepository.append(snapshot());
    await ModelCatalog.create({
      modelId: 'gpt-corrupt',
      schemaVersion: CATALOG_SCHEMA_VERSION,
      source: 'discovery',
      ownedGroups: ['limits'],
      patch: record({ id: 'gpt-corrupt', contextWindow: 'lots' }),
      effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    });

    const result = await modelCatalogRepository.rowsInForceWithRejects(new Date('2026-07-15T00:00:00Z'));
    expect(result.rows.map(row => row.modelId)).toEqual(['gpt-x']);
    expect(result.rejected).toBe(1);
    expect(result.rejectedModelIds).toEqual(['gpt-corrupt']);
  });

  it('returns full history newest first', async () => {
    await modelCatalogRepository.append(snapshot({ effectiveFrom: new Date('2026-06-01T00:00:00Z'), note: 'june' }));
    await modelCatalogRepository.append(snapshot({ effectiveFrom: new Date('2026-07-01T00:00:00Z'), note: 'july' }));

    const history = await modelCatalogRepository.historyForModel('gpt-x');
    expect(history.map(row => row.note)).toEqual(['july', 'june']);
  });

  // The read contract exists to serve mergeCatalog's per-group precedence, so it
  // is asserted here against the real merge rather than against a paraphrase.
  describe('the row set mergeCatalog consumes', () => {
    const MODEL_ID = String(ChatModels.GPT4_1);
    const AT = new Date('2026-07-15T00:00:00Z');

    /** The adapter literal this model would have without any catalog row. */
    const adapterLiteral: ModelInfo = {
      id: ChatModels.GPT4_1,
      type: 'text',
      name: 'GPT 4.1',
      backend: ModelBackend.OpenAI,
      contextWindow: 128_000,
      max_tokens: 16_384,
      pricing: { 128_000: { input: 2e-6, output: 8e-6 } },
      rank: 5,
      description: 'the adapter description',
    };

    /** seed (t0), a full discovery snapshot (t1), then two sparse operator
     * patches owning different groups (t2, t3) - the layering the defect ate. */
    async function appendLayers(): Promise<void> {
      await modelCatalogRepository.append({
        modelId: MODEL_ID,
        source: 'seed',
        ownedGroups: ['identity', 'limits', 'modalities', 'presentation'],
        patch: record({ id: MODEL_ID, name: 'GPT 4.1', supportsTools: true, rank: 7 }),
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        note: 'adapter-seed',
      });
      await modelCatalogRepository.append({
        modelId: MODEL_ID,
        source: 'discovery',
        ownedGroups: ['identity', 'limits'],
        patch: record({ id: MODEL_ID, name: 'GPT 4.1', contextWindow: 1_000_000 }),
        effectiveFrom: new Date('2026-02-01T00:00:00Z'),
        note: 'discovery',
      });
      await modelCatalogRepository.append({
        modelId: MODEL_ID,
        source: 'operator',
        ownedGroups: ['presentation'],
        patch: { rank: 99 },
        effectiveFrom: new Date('2026-03-01T00:00:00Z'),
        note: 'pinned to the top',
      });
      await modelCatalogRepository.append({
        modelId: MODEL_ID,
        source: 'operator',
        ownedGroups: ['availability'],
        patch: { disabled: true, disabledReason: 'paused during an incident' },
        effectiveFrom: new Date('2026-04-01T00:00:00Z'),
        note: 'paused',
      });
    }

    it('keeps the newest row per source and every operator row, newest first', async () => {
      await appendLayers();
      await modelCatalogRepository.append({
        modelId: MODEL_ID,
        source: 'discovery',
        ownedGroups: ['limits'],
        patch: record({ id: MODEL_ID, name: 'GPT 4.1', contextWindow: 8_192 }),
        effectiveFrom: new Date('2025-12-01T00:00:00Z'),
        note: 'superseded discovery',
      });

      const rows = await modelCatalogRepository.rowsInForce(AT);

      expect(rows.map(row => [row.source, row.note])).toEqual([
        ['operator', 'paused'],
        ['operator', 'pinned to the top'],
        ['discovery', 'discovery'],
        ['seed', 'adapter-seed'],
      ]);
    });

    it('lets a sparse operator patch overlay only its own groups, not shadow the whole model', async () => {
      await appendLayers();

      const [merged] = mergeCatalog([adapterLiteral], await modelCatalogRepository.rowsInForce(AT), {
        apiKeys: null,
        isSelfHost: false,
      });

      // Collapsing the read to one row per model would leave every one of these
      // at the adapter literal, the newest operator patch owning {availability}
      // being all the merge ever saw.
      expect(merged.contextWindow).toBe(1_000_000);
      expect(merged.supportsTools).toBe(true);
      expect(merged.rank).toBe(99);
      expect(merged.disabled).toBe(true);
      expect(merged.disabledReason).toBe('paused during an incident');
    });

    it('applies both operator rows when they own different groups', async () => {
      await appendLayers();
      const rows = await modelCatalogRepository.rowsInForce(AT);

      // Drop the {presentation} patch and the seed row behind it takes the group
      // back - proof that the seed row is in the set too, not just the newest two.
      const withoutTheOlderPatch = rows.filter(row => row.note !== 'pinned to the top');
      expect(mergeCatalog([adapterLiteral], withoutTheOlderPatch, { apiKeys: null, isSelfHost: false })[0].rank).toBe(
        7
      );
      expect(mergeCatalog([adapterLiteral], rows, { apiKeys: null, isSelfHost: false })[0]).toMatchObject({
        rank: 99,
        disabled: true,
      });
    });
  });
});
