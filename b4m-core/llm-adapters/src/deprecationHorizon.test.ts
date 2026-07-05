import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getExpiringModels, logExpiringModels } from './deprecationHorizon';
import type { ModelInfo } from '@bike4mind/common';

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
