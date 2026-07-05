import { describe, it, expect } from 'vitest';
import { isModelDeprecated, ModelInfo } from '../models';

function makeModel(deprecationDate?: string): ModelInfo {
  return {
    id: 'test-model',
    type: 'text',
    name: 'Test Model',
    backend: 'anthropic',
    supportsImageVariation: false,
    contextWindow: 200000,
    max_tokens: 4096,
    can_stream: true,
    pricing: { 200000: { input: 0.003, output: 0.015 } },
    deprecationDate,
  } as ModelInfo;
}

describe('isModelDeprecated', () => {
  it('should return false when no deprecationDate is set', () => {
    expect(isModelDeprecated(makeModel())).toBe(false);
    expect(isModelDeprecated(makeModel(undefined))).toBe(false);
  });

  it('should return true when deprecationDate is in the past', () => {
    expect(isModelDeprecated(makeModel('2024-01-01'))).toBe(true);
  });

  it('should return false when deprecationDate is far in the future', () => {
    expect(isModelDeprecated(makeModel('2099-12-31'))).toBe(false);
  });

  it('should return true on the exact deprecation date', () => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    expect(isModelDeprecated(makeModel(todayStr), today)).toBe(true);
  });

  it('should return false one day before the deprecation date', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const today = new Date();
    expect(isModelDeprecated(makeModel(tomorrowStr), today)).toBe(false);
  });

  it('should return true one day after the deprecation date', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const today = new Date();
    expect(isModelDeprecated(makeModel(yesterdayStr), today)).toBe(true);
  });

  it('should accept a custom `now` date for testing', () => {
    const model = makeModel('2025-06-15');
    expect(isModelDeprecated(model, new Date('2025-06-14T23:59:59Z'))).toBe(false);
    expect(isModelDeprecated(model, new Date('2025-06-15T00:00:00Z'))).toBe(true);
    expect(isModelDeprecated(model, new Date('2025-06-16T00:00:00Z'))).toBe(true);
  });
});
