import { describe, it, expect, beforeEach } from 'vitest';
import { collectStaticTextModels, generateModelPriceSeed } from './generateModelPriceSeed';
import { seedModelPrices, SEED_NOTE } from './seedModelPrices';
import seedFile from './modelPrices.seed.json';
import { ModelPrice, modelPriceRepository } from '../models/billing/ModelPriceModel';
import { setupMongoTest } from '../__test__/utils';

// JSON import infers a literal union per entry; widen through unknown.
const seed = seedFile as unknown as {
  generatedAt: string;
  entries: Array<{ modelId: string; pricing: Record<string, { input: number; output: number }> }>;
};

describe('model price seed (no DB)', () => {
  it('the checked-in seed file is fresh (regenerating from the adapter tables produces it)', async () => {
    // Fails when an adapter price literal changes without regenerating the
    // seed - the diff of modelPrices.seed.json IS the price-change review.
    const generated = await generateModelPriceSeed();
    expect(generated).toEqual(seed.entries);
  });

  it('the seed carries a valid generation timestamp (the deterministic effectiveFrom)', () => {
    expect(Number.isFinite(new Date(seed.generatedAt).getTime())).toBe(true);
  });

  it('covers every static text model: a catalog row or an explicit freeToRun', async () => {
    const models = await collectStaticTextModels();
    const seeded = new Set(seed.entries.map(e => e.modelId));
    const uncovered = models.filter(m => !m.freeToRun && !seeded.has(m.id as string));
    expect(uncovered.map(m => m.id)).toEqual([]);
  });

  it('every seed entry carries a nonzero price (a zero row would settle calls free)', () => {
    const zeroPriced = seed.entries.filter(
      entry => !Object.values(entry.pricing).some(tier => tier.input > 0 || tier.output > 0)
    );
    expect(zeroPriced.map(e => e.modelId)).toEqual([]);
  });
});

describe('seedModelPrices (round-trip)', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ModelPrice.deleteMany({});
  });

  it('inserts every entry once and is idempotent on re-run', async () => {
    const first = await seedModelPrices(modelPriceRepository);
    expect(first.inserted).toBe(seed.entries.length);
    expect(first.skipped).toBe(0);

    const second = await seedModelPrices(modelPriceRepository);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);

    const rows = await modelPriceRepository.rowsInForce(new Date(seed.generatedAt));
    expect(rows.length).toBe(first.inserted);
  });

  it('propagates a changed adapter price over an older seed row (the reprice-reaches-production path)', async () => {
    const target = seed.entries[0];
    await modelPriceRepository.append({
      modelId: target.modelId,
      unit: 'per_token',
      pricing: { '1000': { input: 99e-6, output: 99e-6 } },
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: SEED_NOTE,
    });

    const result = await seedModelPrices(modelPriceRepository);
    expect(result.inserted).toBe(seed.entries.length);

    const history = await modelPriceRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(2);
    expect(history[0].effectiveFrom.toISOString()).toBe(new Date(seed.generatedAt).toISOString());
  });

  it('skips an older seed row whose pricing already matches (no churn rows)', async () => {
    const target = seed.entries[0];
    await modelPriceRepository.append({
      modelId: target.modelId,
      unit: 'per_token',
      pricing: target.pricing,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: SEED_NOTE,
    });

    await seedModelPrices(modelPriceRepository);

    const history = await modelPriceRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
  });

  it('never supersedes an operator-appended reprice, even an older one with different pricing', async () => {
    const target = seed.entries[0];
    await modelPriceRepository.append({
      modelId: target.modelId,
      unit: 'per_token',
      pricing: { '1000': { input: 9e-6, output: 27e-6 } },
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: 'manual reprice',
    });

    await seedModelPrices(modelPriceRepository);

    const history = await modelPriceRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('manual reprice');
  });

  it('append rejects empty and all-zero pricing (guards fat-fingered operator rows)', async () => {
    await expect(
      modelPriceRepository.append({
        modelId: 'gpt-x',
        unit: 'per_token',
        pricing: {},
        effectiveFrom: new Date(),
      })
    ).rejects.toThrow(/empty pricing/);

    await expect(
      modelPriceRepository.append({
        modelId: 'gpt-x',
        unit: 'per_token',
        pricing: { '1000': { input: 0, output: 0 } },
        effectiveFrom: new Date(),
      })
    ).rejects.toThrow(/all-zero pricing/);
  });

  it('append rejects non-numeric tier keys (NaN thresholds scramble tier selection)', async () => {
    await expect(
      modelPriceRepository.append({
        modelId: 'gpt-x',
        unit: 'per_token',
        pricing: { default: { input: 1e-6, output: 2e-6 } },
        effectiveFrom: new Date(),
      })
    ).rejects.toThrow(/numeric token thresholds/);
  });
});
