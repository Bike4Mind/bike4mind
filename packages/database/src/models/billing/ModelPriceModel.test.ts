import { describe, it, expect, beforeEach } from 'vitest';
import { ModelPrice, modelPriceRepository } from './ModelPriceModel';
import { setupMongoTest } from '../../__test__/utils';

const tier = { input: 2e-6, output: 8e-6 };

describe('ModelPriceRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ModelPrice.deleteMany({});
  });

  it('round-trips a row including the pricing tier map', async () => {
    await modelPriceRepository.append({
      modelId: 'gpt-x',
      unit: 'per_token',
      pricing: { '200000': { ...tier, cache_read: 1e-6, cache_write: 3e-6 } },
      effectiveFrom: new Date('2026-07-01T00:00:00Z'),
      note: 'adapter-seed',
    });

    const [row] = await modelPriceRepository.rowsInForce(new Date('2026-07-15T00:00:00Z'));
    expect(row.modelId).toBe('gpt-x');
    expect(row.pricing['200000']).toMatchObject({ input: 2e-6, output: 8e-6, cache_read: 1e-6, cache_write: 3e-6 });
  });

  it('rowsInForce returns the newest effective row per model and unit, ignoring future rows', async () => {
    const base = { modelId: 'gpt-x', unit: 'per_token' as const, pricing: { '200000': tier } };
    await modelPriceRepository.append({ ...base, effectiveFrom: new Date('2026-06-01T00:00:00Z'), note: 'june' });
    await modelPriceRepository.append({ ...base, effectiveFrom: new Date('2026-07-01T00:00:00Z'), note: 'july' });
    await modelPriceRepository.append({ ...base, effectiveFrom: new Date('2026-08-01T00:00:00Z'), note: 'august' });
    await modelPriceRepository.append({
      modelId: 'gpt-x',
      unit: 'per_minute',
      pricing: { '1': { input: 0.06, output: 0 } },
      effectiveFrom: new Date('2026-06-15T00:00:00Z'),
    });

    const rows = await modelPriceRepository.rowsInForce(new Date('2026-07-15T00:00:00Z'));
    expect(rows).toHaveLength(2);
    const perToken = rows.find(r => r.unit === 'per_token');
    const perMinute = rows.find(r => r.unit === 'per_minute');
    expect(perToken?.note).toBe('july');
    expect(perMinute?.pricing['1'].input).toBe(0.06);
  });

  it('historyForModel returns all rows newest first', async () => {
    const base = { modelId: 'gpt-x', unit: 'per_token' as const, pricing: { '200000': tier } };
    await modelPriceRepository.append({ ...base, effectiveFrom: new Date('2026-06-01T00:00:00Z') });
    await modelPriceRepository.append({ ...base, effectiveFrom: new Date('2026-07-01T00:00:00Z') });

    const history = await modelPriceRepository.historyForModel('gpt-x');
    expect(history).toHaveLength(2);
    expect(history[0].effectiveFrom.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects units outside the enum', async () => {
    await expect(
      modelPriceRepository.append({
        modelId: 'gpt-x',
        unit: 'per_wish' as never,
        pricing: { '1': tier },
        effectiveFrom: new Date(),
      })
    ).rejects.toThrow(/unit/);
  });
});
