import { describe, expect, it } from 'vitest';
import { modelAxisLabel } from './analyticsFormat';

describe('modelAxisLabel', () => {
  it('keeps a model id that fits, dots in the version included', () => {
    expect(modelAxisLabel('gpt-4.1')).toBe('gpt-4.1');
    expect(modelAxisLabel('gpt-4.1-mini-2025-04-14')).toBe('gpt-4.1-mini-2025-04-14');
  });

  it('drops a region or provider prefix and marks the label as shortened', () => {
    expect(modelAxisLabel('global.anthropic.claude-sonnet-5')).toBe('\u2026claude-sonnet-5');
    expect(modelAxisLabel('us.meta.llama4-scout-v1:0')).toBe('\u2026llama4-scout-v1:0');
  });

  it('keeps the end of an id that is still too long', () => {
    const label = modelAxisLabel('a-very-long-self-hosted-model-name-q4-k-m');
    expect(label).toBe('\u2026osted-model-name-q4-k-m');
    expect(label).toHaveLength(24);
  });
});
