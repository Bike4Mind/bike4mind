import { describe, expect, it } from 'vitest';
import {
  effortSent,
  localModelId,
  parseGenerationInput,
  parseLocalModelId,
  parseModelContextSetting,
  withinGenerationBounds,
} from './fields';

describe('local model ids', () => {
  it('round-trips a runtime id with a colon and keeps the model raw', () => {
    const id = localModelId('srv-a:b', 'qwen3:8b');
    expect(id).toBe('local:srv-a%3Ab:qwen3:8b');
    expect(parseLocalModelId(id)).toEqual({ runtimeId: 'srv-a:b', model: 'qwen3:8b' });
    expect(parseLocalModelId('local:ollama:qwen3:8b')).toEqual({ runtimeId: 'ollama', model: 'qwen3:8b' });
  });

  it.each(['qwen3:8b', 'local:', 'local:ollama:', 'local:%E0%A4%A:m'])('does not take %j', id => {
    expect(parseLocalModelId(id)).toBeNull();
  });
});

describe('effortSent', () => {
  it('sends a listed level as is, else the nearest listed one, the lower on a tie', () => {
    expect(effortSent('high', ['low', 'medium', 'high'])).toBe('high');
    expect(effortSent('xhigh', ['low', 'medium', 'high'])).toBe('high');
    expect(effortSent('minimal', ['low', 'medium', 'high'])).toBe('low');
    expect(effortSent('medium', ['low', 'high'])).toBe('low');
  });

  it('maps only a stored none to none, and sends nothing for default or no levels', () => {
    expect(effortSent('none', ['none', 'low'])).toBe('none');
    expect(effortSent('none', ['low', 'high'])).toBe('low');
    expect(effortSent('default', ['low'])).toBeUndefined();
    expect(effortSent('high', [])).toBeUndefined();
  });
});

describe('generation bounds', () => {
  it.each([
    ['temperature', 2, true],
    ['temperature', 2.01, false],
    ['topK', 20.5, false],
    ['topP', Number.NaN, false],
    ['maxOutputTokens', Infinity, false],
  ] as const)('%s %d within bounds: %s', (field, value, within) => {
    expect(withinGenerationBounds(field, value)).toBe(within);
  });

  it('rejects a set with any field out of bounds', () => {
    expect(parseGenerationInput({ temperature: 0.6, topK: 1e9 })).toBeNull();
    expect(parseGenerationInput({ temperature: 0.6 })).toEqual({ temperature: 0.6 });
  });
});

describe('parseModelContextSetting', () => {
  it('takes a fixed size or an Auto cap from 512 to the top offered size', () => {
    expect(parseModelContextSetting({ mode: 'fixed', tokens: 40960 })).toEqual({ mode: 'fixed', tokens: 40960 });
    expect(parseModelContextSetting({ mode: 'auto' })).toEqual({ mode: 'auto' });
    expect(parseModelContextSetting({ mode: 'auto', maxTokens: 8192 })).toEqual({ mode: 'auto', maxTokens: 8192 });
  });

  it.each([
    { mode: 'fixed', tokens: 511 },
    { mode: 'fixed', tokens: 524288 },
    { mode: 'auto', maxTokens: Number.NaN },
    { mode: 'stretch' },
    [{ mode: 'auto' }],
    null,
  ])('does not take %j', value => {
    expect(parseModelContextSetting(value)).toBeNull();
  });
});
