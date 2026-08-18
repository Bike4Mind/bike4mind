import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ModelRecordWrite, groupsTouchedByPatch } from '@bike4mind/common';
import type { IModelCatalogRow, ModelInfo } from '@bike4mind/common';
import { getAvailableModels, setModelCatalogProvider } from '@bike4mind/llm-adapters';
import { collectStaticCatalogModels, generateModelCatalogSeed } from './generateModelCatalogSeed';
import { buildSeedNotice } from './regenerateModelCatalogSeed';
import { CATALOG_SEED_NOTE, CATALOG_SEED_SOURCE, seedModelCatalog } from './seedModelCatalog';
import type { ModelCatalogSeedFile } from './seedModelCatalog';
import seedFile from './modelCatalog.seed.json';
import { ModelCatalog, modelCatalogRepository } from '../models/ai/ModelCatalogModel';
import { setupMongoTest } from '../__test__/utils';

// JSON import infers a literal union per entry; widen through unknown.
const seed = seedFile as unknown as ModelCatalogSeedFile;

/** The seed's "last maintained" claim stops being true at some point; 120 days
 * is where CI says so instead of a user discovering it. */
const MAX_SEED_AGE_DAYS = 120;

/**
 * Time-based, so it fails on a date rather than on a change - as a PR-blocking
 * test that means every PR, hotfixes included, starts failing on a day nobody
 * touched the seed. It runs where a scheduled job can act on it. The freshness
 * test above is the deterministic one and stays PR-blocking.
 */
const runStalenessGuard = process.env.B4M_SEED_STALENESS_CHECK === 'true' ? it : it.skip;

describe('model catalog seed (no DB)', () => {
  it('the checked-in seed file is fresh (regenerating from the adapter tables produces it)', async () => {
    // Fails when an adapter table changes without regenerating the seed - the
    // diff of modelCatalog.seed.json IS the review of the fallback tier.
    // Fix with: pnpm turbo:core:build && pnpm --filter @bike4mind/database generate:model-catalog-seed
    const generated = await generateModelCatalogSeed();
    expect(generated).toEqual(seed.entries);
  });

  it('the seed carries a valid generation timestamp (the deterministic effectiveFrom)', () => {
    expect(Number.isFinite(new Date(seed.generatedAt).getTime())).toBe(true);
  });

  runStalenessGuard('is not stale: the "last maintained" notice is still honest', () => {
    const ageDays = (Date.now() - new Date(seed.generatedAt).getTime()) / 86_400_000;
    expect(ageDays).toBeLessThan(MAX_SEED_AGE_DAYS);
  });

  it('carries the fallback notice for the generated date', () => {
    expect(seed.notice).toBe(buildSeedNotice(new Date(seed.generatedAt)));
    expect(seed.notice).toContain('Fallback defaults last maintained on');
    expect(seed.notice).toContain('Models and pricing live-update at runtime');
  });

  it('pins the seed source and note (data contract with rows already in production)', () => {
    // Reclassifying them would make every existing seed row look like an
    // operator edit, permanently freezing catalog corrections.
    expect(CATALOG_SEED_SOURCE).toBe('seed');
    expect(CATALOG_SEED_NOTE).toBe('adapter-seed');
  });

  it('covers every static model exactly once', async () => {
    const models = await collectStaticCatalogModels();
    const seeded = new Set(seed.entries.map(entry => entry.modelId));
    const uncovered = models.filter(model => !seeded.has(String(model.id)));
    expect(uncovered.map(model => model.id)).toEqual([]);
    expect(seeded.size).toBe(seed.entries.length);
  });

  it('every entry passes the strict append schema (a bad entry would abort boot seeding)', () => {
    const invalid = seed.entries
      .map(entry => ({ modelId: entry.modelId, result: ModelRecordWrite.safeParse(entry.patch) }))
      .filter(({ result }) => !result.success);
    expect(invalid.map(({ modelId }) => modelId)).toEqual([]);
  });

  it('claims exactly the groups its patch touches (a row cannot claim unexercised authority)', () => {
    const overclaiming = seed.entries.filter(entry => {
      const touched = groupsTouchedByPatch(entry.patch as unknown as Record<string, unknown>);
      return [...entry.ownedGroups].sort().join() !== [...touched].sort().join();
    });
    expect(overclaiming.map(entry => entry.modelId)).toEqual([]);
  });

  it('never carries pricing: ModelPrice is the only price store', () => {
    const priced = seed.entries.filter(entry => 'pricing' in entry.patch);
    expect(priced.map(entry => entry.modelId)).toEqual([]);
  });

  it('leaves dispatch data to a later phase rather than guessing it', () => {
    // A wrong adapterFamily or dispatchProfile mis-routes a request the moment
    // dispatch consumes it, and neither has a ModelInfo spelling to invert.
    const guessed = seed.entries.filter(entry => 'adapterFamily' in entry.patch || 'dispatchProfile' in entry.patch);
    expect(guessed.map(entry => entry.modelId)).toEqual([]);
  });
});

describe('the checked-in seed applied as catalog rows (no DB)', () => {
  const seedRows = (): IModelCatalogRow[] =>
    seed.entries.map(entry => ({
      modelId: entry.modelId,
      schemaVersion: 1,
      source: 'seed',
      ownedGroups: entry.ownedGroups,
      patch: entry.patch,
      effectiveFrom: new Date(seed.generatedAt),
    }));

  afterEach(() => {
    setModelCatalogProvider(null);
  });

  it('leaves the assembled model list unchanged apart from optional-boolean normalization', async () => {
    // The fallback tier must be a no-op against the tables it was generated
    // from: a fresh self-host boot seeds the catalog and the picker must not
    // move. The only permitted drift is toModelInfo's documented defaults
    // turning an absent optional boolean into an explicit false, which no
    // consumer can distinguish.
    setModelCatalogProvider(null);
    const before = await getAvailableModels(null);
    setModelCatalogProvider(async () => seedRows());
    const after = await getAvailableModels(null);

    expect(after.map(model => model.id)).toEqual(before.map(model => model.id));

    const byId = new Map(after.map(model => [model.id, model]));
    for (const original of before) {
      const merged = byId.get(original.id)!;
      for (const key of Object.keys(merged) as Array<keyof ModelInfo>) {
        if (JSON.stringify(merged[key]) === JSON.stringify(original[key])) continue;
        expect({ id: original.id, key, from: original[key], to: merged[key] }).toMatchObject({
          from: undefined,
          to: false,
        });
      }
    }
  });
});

describe('seedModelCatalog (round-trip)', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ModelCatalog.deleteMany({});
    // The (modelId, effectiveFrom) unique index is what turns the seeding race
    // into a skip; setupMongoTest does not create it for this model.
    await ModelCatalog.ensureIndexes();
  });

  it('inserts every entry once and is idempotent on re-run', async () => {
    const first = await seedModelCatalog(modelCatalogRepository);
    expect(first.inserted).toBe(seed.entries.length);
    expect(first.skipped).toBe(0);

    const second = await seedModelCatalog(modelCatalogRepository);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);

    const rows = await modelCatalogRepository.rowsInForce(new Date(seed.generatedAt));
    expect(rows.length).toBe(first.inserted);
    expect(rows.every(row => row.source === CATALOG_SEED_SOURCE)).toBe(true);
  });

  it('propagates a changed adapter table over an older seed row (the fix-reaches-production path)', async () => {
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'seed',
      patch: { ...target.patch, contextWindow: 7 },
      ownedGroups: target.ownedGroups,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: CATALOG_SEED_NOTE,
    });

    const result = await seedModelCatalog(modelCatalogRepository);
    expect(result.inserted).toBe(seed.entries.length);

    const history = await modelCatalogRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(2);
    expect(history[0].effectiveFrom.toISOString()).toBe(new Date(seed.generatedAt).toISOString());
    expect(history[0].patch.contextWindow).toBe(target.patch.contextWindow);
  });

  it('skips an older seed row whose record already matches (no churn rows)', async () => {
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'seed',
      patch: target.patch,
      ownedGroups: target.ownedGroups,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: CATALOG_SEED_NOTE,
    });

    await seedModelCatalog(modelCatalogRepository);

    const history = await modelCatalogRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
  });

  it('never supersedes an operator row, even an older one with a different record', async () => {
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'operator',
      patch: { rank: 1 },
      ownedGroups: ['presentation'],
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: 'pinned by an admin',
    });

    await seedModelCatalog(modelCatalogRepository);

    const history = await modelCatalogRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('pinned by an admin');
  });

  it('supersedes an older discovery row with different content (the automation carve-out)', async () => {
    // Without it, one automated row would freeze seed corrections for that model
    // permanently: seeding used to read every non-seed row as an operator edit.
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'discovery',
      patch: { ...target.patch, contextWindow: 11 },
      ownedGroups: target.ownedGroups,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: 'discovery:models.dev@2020-01-01',
    });

    await seedModelCatalog(modelCatalogRepository);

    const history = await modelCatalogRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(2);
    expect(history[0].source).toBe(CATALOG_SEED_SOURCE);
    expect(history[0].patch.contextWindow).toBe(target.patch.contextWindow);
  });

  it('leaves a discovery row at or after the seed version alone (discovery is sticky against itself)', async () => {
    for (const [entry, effectiveFrom] of [
      [seed.entries[0], new Date(seed.generatedAt)],
      [seed.entries[1], new Date(new Date(seed.generatedAt).getTime() + 86_400_000)],
    ] as const) {
      await modelCatalogRepository.append({
        modelId: entry.modelId,
        source: 'discovery',
        patch: { ...entry.patch, contextWindow: 11 },
        ownedGroups: entry.ownedGroups,
        effectiveFrom,
        note: `discovery:models.dev@${effectiveFrom.toISOString()}`,
      });
    }

    await seedModelCatalog(modelCatalogRepository);

    for (const entry of [seed.entries[0], seed.entries[1]]) {
      const history = await modelCatalogRepository.historyForModel(entry.modelId);
      expect(history).toHaveLength(1);
      expect(history[0].source).toBe('discovery');
    }
  });

  it('is idempotent over a superseded discovery row (no churn row per boot)', async () => {
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'discovery',
      patch: { ...target.patch, contextWindow: 11 },
      ownedGroups: target.ownedGroups,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: 'discovery:models.dev@2020-01-01',
    });

    await seedModelCatalog(modelCatalogRepository);
    await seedModelCatalog(modelCatalogRepository);

    expect(await modelCatalogRepository.historyForModel(target.modelId)).toHaveLength(2);
  });

  it('treats a concurrent identical append as a skip (E11000 is a race, not an error)', async () => {
    // The real race: another seeder inserts between this one's rowsInForce read
    // and its append. Reproduced by holding the read at empty while the row is
    // already in the collection.
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'seed',
      patch: target.patch,
      ownedGroups: target.ownedGroups,
      effectiveFrom: new Date(seed.generatedAt),
      note: CATALOG_SEED_NOTE,
    });
    const racedRepository = Object.create(modelCatalogRepository) as typeof modelCatalogRepository;
    racedRepository.rowsInForce = async () => [];

    const result = await seedModelCatalog(racedRepository);

    expect(result.inserted).toBe(seed.entries.length - 1);
    expect(result.skipped).toBe(1);
    const history = await modelCatalogRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
  });

  it('warns loudly when an entry changed without a generatedAt bump (hand-edit footgun)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'seed',
      patch: { ...target.patch, contextWindow: 5 },
      ownedGroups: target.ownedGroups,
      effectiveFrom: new Date(seed.generatedAt),
      note: CATALOG_SEED_NOTE,
    });

    await seedModelCatalog(modelCatalogRepository);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(target.modelId);
    expect(warn.mock.calls[0][0]).toContain('generate:model-catalog-seed');
    const history = await modelCatalogRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
    warn.mockRestore();
  });

  it('does not warn on a strictly newer seed row (rollback / mixed-version fleet)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = seed.entries[0];
    await modelCatalogRepository.append({
      modelId: target.modelId,
      source: 'seed',
      patch: { ...target.patch, contextWindow: 5 },
      ownedGroups: target.ownedGroups,
      effectiveFrom: new Date(new Date(seed.generatedAt).getTime() + 86_400_000),
      note: CATALOG_SEED_NOTE,
    });

    await seedModelCatalog(modelCatalogRepository);

    expect(warn).not.toHaveBeenCalled();
    const history = await modelCatalogRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
    warn.mockRestore();
  });
});
