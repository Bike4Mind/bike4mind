import { describe, it, expect, beforeEach } from 'vitest';
import { collectStaticTextModels, generateModelPriceSeed } from './generateModelPriceSeed';
import { seedModelPrices } from './seedModelPrices';
import seedFile from './modelPrices.seed.json';
import { ModelPrice, modelPriceRepository } from '../models/billing/ModelPriceModel';
import { setupMongoTest } from '../__test__/utils';

describe('model price seed (no DB)', () => {
  it('the checked-in seed file is fresh (regenerating from the adapter tables produces it)', async () => {
    // Fails when an adapter price literal changes without regenerating the
    // seed - the diff of modelPrices.seed.json IS the price-change review.
    const generated = await generateModelPriceSeed();
    expect(generated).toEqual(seedFile);
  });

  // JSON import infers a literal union per entry; widen through unknown.
  const entries = seedFile as unknown as Array<{
    modelId: string;
    pricing: Record<string, { input: number; output: number }>;
  }>;

  it('covers every static text model: a catalog row or an explicit freeToRun', async () => {
    const models = await collectStaticTextModels();
    const seeded = new Set(entries.map(e => e.modelId));
    const uncovered = models.filter(m => !m.freeToRun && !seeded.has(m.id as string));
    expect(uncovered.map(m => m.id)).toEqual([]);
  });

  it('every seed entry carries a nonzero price (a zero row would settle calls free)', () => {
    const zeroPriced = entries.filter(
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
    const effectiveFrom = new Date('2026-07-09T00:00:00Z');

    const first = await seedModelPrices(modelPriceRepository, { effectiveFrom });
    expect(first.inserted).toBeGreaterThan(0);
    expect(first.skipped).toBe(0);

    const second = await seedModelPrices(modelPriceRepository, { effectiveFrom });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);

    const rows = await modelPriceRepository.rowsInForce(new Date('2026-07-10T00:00:00Z'));
    expect(rows.length).toBe(first.inserted);
  });

  it('never overrides an operator-appended reprice', async () => {
    await modelPriceRepository.append({
      modelId: 'gpt-5.2',
      unit: 'per_token',
      pricing: { '400000': { input: 9e-6, output: 27e-6 } },
      effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      note: 'manual reprice',
    });

    await seedModelPrices(modelPriceRepository, { effectiveFrom: new Date('2026-07-09T00:00:00Z') });

    const history = await modelPriceRepository.historyForModel('gpt-5.2');
    expect(history).toHaveLength(1);
    expect(history[0].note).toBe('manual reprice');
  });
});
