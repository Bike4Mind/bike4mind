import { describe, expect, it } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { conservativeRoundInputUsd } from './chatCreditCap';

// $5/M input, $25/M output.
const MODEL = {
  id: 'cap-test-model',
  backend: ModelBackend.Anthropic,
  pricing: { 1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
} as unknown as ModelInfo;

describe('conservativeRoundInputUsd', () => {
  it('prices input at the cache-write rate, the dearest a 5-minute cache can bill', () => {
    expect(conservativeRoundInputUsd(MODEL, 10_000, '5m')).toBeCloseTo(10_000 * (5 / 1_000_000) * 1.25, 10);
  });

  it('prices a 1-hour session at the 1-hour write rate', () => {
    expect(conservativeRoundInputUsd(MODEL, 10_000, '1h')).toBeGreaterThan(conservativeRoundInputUsd(MODEL, 10_000, '5m'));
  });

  it('never prices below plain input when a model publishes a cheaper cache write', () => {
    const cheapWrite = {
      ...MODEL,
      pricing: { 1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000, cache_write: 1 / 1_000_000 } },
    } as unknown as ModelInfo;
    expect(conservativeRoundInputUsd(cheapWrite, 10_000, '5m')).toBeCloseTo(10_000 * (5 / 1_000_000), 10);
  });

  it('is zero for no input', () => {
    expect(conservativeRoundInputUsd(MODEL, 0, '5m')).toBe(0);
  });
});
