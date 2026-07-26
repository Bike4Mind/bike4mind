import { describe, it, expect, beforeEach } from 'vitest';
import { CATALOG_SCHEMA_VERSION, IModelCatalogRowInput, ModelBackend } from '@bike4mind/common';
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

  it('returns one row per model, ignores future-dated rows, and time-travels', async () => {
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
});
