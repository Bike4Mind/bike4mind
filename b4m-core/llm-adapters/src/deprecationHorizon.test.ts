import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { catalogLifecycles, getExpiredCatalogModels, getExpiringModels, logExpiringModels } from './deprecationHorizon';
import type { IModelCatalogRow, ModelInfo } from '@bike4mind/common';

function makeModel(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: 'test-model',
    type: 'text',
    name: 'Test Model',
    backend: 'anthropic' as ModelInfo['backend'],
    supportsImageVariation: false,
    contextWindow: 200000,
    max_tokens: 4096,
    can_stream: true,
    pricing: { 200000: { input: 0.003, output: 0.015 } },
    ...overrides,
  };
}

describe('getExpiringModels', () => {
  it('should return models expiring within the horizon', () => {
    const today = new Date();
    const inFiveDays = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);
    const dateStr = inFiveDays.toISOString().slice(0, 10);

    const models = [
      makeModel({ id: 'expiring-soon', name: 'Expiring Soon', deprecationDate: dateStr }),
      makeModel({ id: 'no-deprecation', name: 'No Deprecation' }),
    ];

    const result = getExpiringModels(models, 30);
    expect(result).toHaveLength(1);
    expect(result[0].modelId).toBe('expiring-soon');
    expect(result[0].daysRemaining).toBeLessThanOrEqual(6);
    expect(result[0].daysRemaining).toBeGreaterThanOrEqual(4);
  });

  it('should return already-expired models with negative daysRemaining', () => {
    const models = [makeModel({ id: 'expired', name: 'Expired', deprecationDate: '2024-01-01' })];

    const result = getExpiringModels(models, 30);
    expect(result).toHaveLength(1);
    expect(result[0].daysRemaining).toBeLessThan(0);
  });

  it('should not return models far in the future', () => {
    const models = [makeModel({ id: 'future', name: 'Future', deprecationDate: '2099-12-31' })];

    const result = getExpiringModels(models, 30);
    expect(result).toHaveLength(0);
  });

  it('should sort by daysRemaining ascending', () => {
    const today = new Date();
    const in5 = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const in20 = new Date(today.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const models = [
      makeModel({ id: 'later', name: 'Later', deprecationDate: in20 }),
      makeModel({ id: 'sooner', name: 'Sooner', deprecationDate: in5 }),
    ];

    const result = getExpiringModels(models, 30);
    expect(result[0].modelId).toBe('sooner');
    expect(result[1].modelId).toBe('later');
  });
});

function makeRow(overrides: Partial<IModelCatalogRow> & { modelId: string }): IModelCatalogRow {
  return {
    schemaVersion: 1,
    source: 'discovery',
    ownedGroups: ['lifecycle'],
    patch: {},
    effectiveFrom: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  } as IModelCatalogRow;
}

const NOW = new Date('2026-07-26T00:00:00Z');

describe('catalogLifecycles', () => {
  it('reads the lifecycle the merge would apply, operator row over discovery row', () => {
    const lifecycles = catalogLifecycles([
      makeRow({ modelId: 'gpt-x', patch: { lifecycle: { status: 'deprecated', deprecationDate: '2026-08-01' } } }),
      makeRow({
        modelId: 'gpt-x',
        source: 'operator',
        effectiveFrom: new Date('2026-07-02T00:00:00Z'),
        patch: { lifecycle: { status: 'active' } },
      }),
      makeRow({ modelId: 'gpt-y', patch: { contextWindow: 1000 } }),
    ]);

    expect(lifecycles.get('gpt-x')).toMatchObject({ status: 'active' });
    // A row that never touched the lifecycle group contributes no entry.
    expect(lifecycles.has('gpt-y')).toBe(false);
  });

  it('carries a lifecycle a later build wrote with no status', () => {
    // The read schema is partial all the way down, so a status-less lifecycle
    // reaches here instead of costing the row: the date still has to drive the
    // picker filter and the EXPIRED view.
    const lifecycles = catalogLifecycles([
      makeRow({ modelId: 'gpt-x', patch: { lifecycle: { deprecationDate: '2026-08-01' } } }),
    ]);

    expect(lifecycles.get('gpt-x')).toEqual({
      status: undefined,
      deprecationDate: '2026-08-01',
      retirementDate: undefined,
      replacedBy: undefined,
    });
    expect(getExpiredCatalogModels(lifecycles, new Date('2026-09-01T00:00:00Z'))).toMatchObject([
      { modelId: 'gpt-x', deprecationDate: '2026-08-01' },
    ]);
  });
});

describe('getExpiredCatalogModels', () => {
  it('lists what the picker filter hides: passed dates and sunset statuses', () => {
    const expired = getExpiredCatalogModels(
      new Map([
        ['live', { status: 'active' }],
        ['scheduled', { status: 'active', deprecationDate: '2026-12-01' }],
        ['past-date', { status: 'active', deprecationDate: '2026-07-01' }],
        ['status-only', { status: 'retired' }],
      ]),
      NOW
    );

    expect(expired.map(m => m.modelId)).toEqual(['past-date', 'status-only']);
    expect(expired[0].daysRemaining).toBe(-25);
    // Nothing to rank a status-only entry by, so it carries no day count.
    expect(expired[1].daysRemaining).toBeUndefined();
  });

  it('ranks by the earliest date that has passed, most overdue first', () => {
    const expired = getExpiredCatalogModels(
      new Map([
        ['recent', { status: 'deprecated', deprecationDate: '2026-07-20' }],
        ['ancient', { status: 'retired', deprecationDate: '2025-01-01', retirementDate: '2025-06-01' }],
      ]),
      NOW
    );

    expect(expired.map(m => m.modelId)).toEqual(['ancient', 'recent']);
  });
});

describe('logExpiringModels', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log warnings for expiring models', () => {
    const models = [makeModel({ id: 'expired', name: 'Old Model', deprecationDate: '2024-01-01' })];

    logExpiringModels(models, 30);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[model-sunset] EXPIRED'));
  });

  it('should not log if no models are expiring', () => {
    const models = [makeModel({ id: 'future', name: 'Future', deprecationDate: '2099-12-31' })];

    logExpiringModels(models, 30);

    expect(console.warn).not.toHaveBeenCalled();
  });
});
