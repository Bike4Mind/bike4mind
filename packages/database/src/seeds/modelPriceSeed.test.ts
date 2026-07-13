import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    // Fix with: pnpm --filter @bike4mind/database generate:model-price-seed
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

  it('pins SEED_NOTE to the persisted value (data contract with rows already in production)', () => {
    // Renaming the constant would reclassify every existing adapter-seed row
    // as an operator reprice, permanently freezing price corrections.
    expect(SEED_NOTE).toBe('adapter-seed');
  });

  it('includes realtime voice rates with audio pricing (the voice settlement path reads these)', () => {
    const realtime = seed.entries.find(e => e.modelId === 'gpt-realtime-1.5');
    expect(realtime).toBeDefined();
    const tier = Object.values(realtime!.pricing)[0] as Record<string, number>;
    expect(tier.audio_input).toBeGreaterThan(0);
    expect(tier.audio_output).toBeGreaterThan(0);
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

  it('warns loudly when a seed entry changed without a generatedAt bump (hand-edit footgun)', async () => {
    // entries edited in place with generatedAt untouched: the alreadyCurrent
    // skip drops the price change, leaving deployments on the stale row. The
    // seeder cannot fix it (equal effectiveFrom collides on the unique index)
    // but it must not stay silent about it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = seed.entries[0];
    await modelPriceRepository.append({
      modelId: target.modelId,
      unit: 'per_token',
      pricing: { '1000': { input: 99e-6, output: 99e-6 } },
      effectiveFrom: new Date(seed.generatedAt),
      note: SEED_NOTE,
    });

    await seedModelPrices(modelPriceRepository);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(target.modelId);
    expect(warn.mock.calls[0][0]).toContain('generate:model-price-seed');
    const history = await modelPriceRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
    warn.mockRestore();
  });

  it('does not warn on a strictly newer seed row (rollback / mixed-version fleet, not a hand-edit)', async () => {
    // An older-code instance booting after a newer seed landed sees exactly
    // "newest row differs, alreadyCurrent" - that is version skew, not the
    // unbumped-generatedAt footgun. Only equal timestamps indicate a hand-edit.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = seed.entries[0];
    await modelPriceRepository.append({
      modelId: target.modelId,
      unit: 'per_token',
      pricing: { '1000': { input: 99e-6, output: 99e-6 } },
      effectiveFrom: new Date(new Date(seed.generatedAt).getTime() + 86_400_000),
      note: SEED_NOTE,
    });

    await seedModelPrices(modelPriceRepository);

    expect(warn).not.toHaveBeenCalled();
    const history = await modelPriceRepository.historyForModel(target.modelId);
    expect(history).toHaveLength(1);
    warn.mockRestore();
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

  it('propagates an audio-only reprice (normalizePricing must see the audio fields)', async () => {
    // If normalizePricing omitted audio_* fields, an older seed row differing
    // ONLY in an audio rate would compare as "same price" and never version.
    const realtime = seed.entries.find(e => e.modelId === 'gpt-realtime-1.5')!;
    const [threshold, tier] = Object.entries(realtime.pricing)[0] as [
      string,
      { input: number; output: number; audio_output: number },
    ];
    await modelPriceRepository.append({
      modelId: realtime.modelId,
      unit: 'per_token',
      pricing: { [threshold]: { ...tier, audio_output: tier.audio_output * 2 } },
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      note: SEED_NOTE,
    });

    await seedModelPrices(modelPriceRepository);

    const history = await modelPriceRepository.historyForModel(realtime.modelId);
    expect(history).toHaveLength(2);
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
