import { describe, it, expect } from 'vitest';
import { applyModelPriceCatalog, resolveModelPriceRow } from '../modelPriceCatalog';
import { ModelBackend, type ModelInfo } from '../models';
import type { IModelPrice } from '../types/entities/ModelPriceTypes';

const model = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo =>
  ({
    id: id as ModelInfo['id'],
    type: 'text',
    name: id,
    backend: ModelBackend.OpenAI,
    contextWindow: 200_000,
    max_tokens: 4096,
    pricing: { 200_000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
    supportsImageVariation: false,
    ...overrides,
  }) as ModelInfo;

const row = (modelId: string, overrides: Partial<IModelPrice> = {}): IModelPrice =>
  ({
    modelId,
    unit: 'per_token',
    pricing: { '200000': { input: 2 / 1_000_000, output: 8 / 1_000_000 } },
    effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  }) as IModelPrice;

describe('resolveModelPriceRow', () => {
  it('picks the newest row effective at or before the given time', () => {
    const rows = [
      row('gpt-x', { effectiveFrom: new Date('2026-06-01T00:00:00Z'), note: 'june' }),
      row('gpt-x', { effectiveFrom: new Date('2026-07-01T00:00:00Z'), note: 'july' }),
      row('gpt-x', { effectiveFrom: new Date('2026-08-01T00:00:00Z'), note: 'august' }),
    ];
    const resolved = resolveModelPriceRow(rows, 'gpt-x', 'per_token', new Date('2026-07-15T00:00:00Z'));
    expect(resolved?.note).toBe('july');
  });

  it('returns undefined when every row is still in the future', () => {
    const rows = [row('gpt-x', { effectiveFrom: new Date('2026-08-01T00:00:00Z') })];
    expect(resolveModelPriceRow(rows, 'gpt-x', 'per_token', new Date('2026-07-15T00:00:00Z'))).toBeUndefined();
  });

  it('returns undefined for a model with no rows', () => {
    expect(resolveModelPriceRow([row('other')], 'gpt-x', 'per_token', new Date())).toBeUndefined();
  });
});

describe('applyModelPriceCatalog', () => {
  it('replaces pricing from the row in force, converting tier keys to numbers', () => {
    const [priced] = applyModelPriceCatalog([model('gpt-x')], [row('gpt-x')], new Date('2026-07-15T00:00:00Z'));
    expect(priced.pricing[200_000]).toEqual({ input: 2 / 1_000_000, output: 8 / 1_000_000 });
  });

  it('leaves a model on its adapter literal when no row exists', () => {
    const [unpriced] = applyModelPriceCatalog([model('gpt-x')], [], new Date());
    expect(unpriced.pricing[200_000].input).toBe(10 / 1_000_000);
  });

  it('leaves a model on its adapter literal when its only row is future-dated', () => {
    const rows = [row('gpt-x', { effectiveFrom: new Date('2099-01-01T00:00:00Z') })];
    const [unpriced] = applyModelPriceCatalog([model('gpt-x')], rows, new Date());
    expect(unpriced.pricing[200_000].input).toBe(10 / 1_000_000);
  });

  it('only applies per_token rows to text models (other units are for their own settlement paths)', () => {
    const rows = [row('gpt-x', { unit: 'per_minute', pricing: { '1': { input: 0.06, output: 0 } } })];
    const [unpriced] = applyModelPriceCatalog([model('gpt-x')], rows, new Date('2026-07-15T00:00:00Z'));
    expect(unpriced.pricing[200_000].input).toBe(10 / 1_000_000);
  });

  it('a newer row of another unit never shadows the in-force per_token row', () => {
    const rows = [
      row('gpt-x', { effectiveFrom: new Date('2026-03-01T00:00:00Z') }),
      row('gpt-x', {
        unit: 'per_minute',
        pricing: { '1': { input: 0.06, output: 0 } },
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
      }),
    ];
    const [priced] = applyModelPriceCatalog([model('gpt-x')], rows, new Date('2026-07-15T00:00:00Z'));
    expect(priced.pricing[200_000]).toEqual({ input: 2 / 1_000_000, output: 8 / 1_000_000 });
  });

  it('preserves cache_read/cache_write overrides from the row', () => {
    const rows = [
      row('gpt-x', {
        pricing: { '200000': { input: 2e-6, output: 8e-6, cache_read: 1e-6, cache_write: 3e-6 } },
      }),
    ];
    const [priced] = applyModelPriceCatalog([model('gpt-x')], rows, new Date('2026-07-15T00:00:00Z'));
    expect(priced.pricing[200_000].cache_read).toBe(1e-6);
    expect(priced.pricing[200_000].cache_write).toBe(3e-6);
  });

  it('does not mutate the input models', () => {
    const original = model('gpt-x');
    applyModelPriceCatalog([original], [row('gpt-x')], new Date('2026-07-15T00:00:00Z'));
    expect(original.pricing[200_000].input).toBe(10 / 1_000_000);
  });
});
