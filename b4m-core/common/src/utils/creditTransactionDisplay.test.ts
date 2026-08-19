import { describe, it, expect } from 'vitest';
import { resolveModelName } from './creditTransactionDisplay';

// Empty-string and non-string values must fall through, not become a chart label.
describe('resolveModelName', () => {
  it.each([
    ['metadata string wins', { metadata: { modelName: 'gpt-5' }, model: 'claude' }, 'gpt-5'],
    ['falls back to the model field', { metadata: {}, model: 'claude' }, 'claude'],
    ['empty metadata name falls through', { metadata: { modelName: '' }, model: 'claude' }, 'claude'],
    ['non-string metadata name falls through', { metadata: { modelName: 42 }, model: 'claude' }, 'claude'],
    ['no usable source at all', { metadata: {} }, 'Unknown'],
    ['absent metadata', {}, 'Unknown'],
    ['non-string model field', { metadata: {}, model: 99 }, 'Unknown'],
  ])('%s', (_name, input, expected) => {
    expect(resolveModelName(input)).toBe(expected);
  });
});
