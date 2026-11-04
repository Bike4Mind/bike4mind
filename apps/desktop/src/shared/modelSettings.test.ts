import { describe, expect, it } from 'vitest';
import {
  isModelSettingsId,
  normalizeModelSettings,
  parseModelSettingsFile,
  parseModelSettingsInput,
} from './modelSettings';

const QWEN = 'local:ollama:qwen3.8:27b';

describe('parseModelSettingsFile', () => {
  it('keeps valid entries and drops unknown keys, invalid values and ids that are not device-side', () => {
    const parsed = parseModelSettingsFile({
      version: 9,
      models: {
        [QWEN]: { generation: { temperature: 0.6, topK: 'many', bogus: 1 }, effort: 'high', extra: true },
        'local:srv-abc:gpt-oss': { effort: 'default' },
        'claude-sonnet': { generation: { temperature: 0.2 } },
        __proto__: { generation: { temperature: 0.2 } },
        'local:ollama:empty': { generation: { temperature: 99 } },
      },
    });
    expect([...(parsed ?? [])]).toEqual([[QWEN, { generation: { temperature: 0.6 }, effort: 'high' }]]);
  });

  it.each([null, 'text', [], { models: [] }, { models: 'x' }, {}, { model: {} }])(
    'does not take %j for a file',
    raw => {
      expect(parseModelSettingsFile(raw)).toBeNull();
    }
  );

  it('reads a file with no models as no defaults', () => {
    expect(parseModelSettingsFile({ models: {} })?.size).toBe(0);
  });
});

describe('parseModelSettingsInput', () => {
  it('accepts a full set and treats {} as a clear', () => {
    expect(parseModelSettingsInput({ generation: { topP: 0.9 }, effort: 'low' })).toEqual({
      generation: { topP: 0.9 },
      effort: 'low',
    });
    expect(parseModelSettingsInput({})).toEqual({});
    expect(parseModelSettingsInput({ generation: {} })).toEqual({});
  });

  it.each([
    null,
    'hot',
    { generation: { temperature: 50 } },
    { generation: { temperature: '0.5' } },
    { effort: 'default' },
    { effort: 'turbo' },
    { generaton: { temperature: 0.5 } },
  ])('rejects %j', raw => {
    expect(parseModelSettingsInput(raw)).toBeNull();
  });
});

describe('load settings', () => {
  it('accepts a context choice, a draft count and a keep-alive', () => {
    expect(
      parseModelSettingsInput({ context: { mode: 'auto', maxTokens: 65536 }, draftTokens: 0, keepAlive: -1 })
    ).toEqual({ context: { mode: 'auto', maxTokens: 65536 }, draftTokens: 0, keepAlive: -1 });
    expect(parseModelSettingsInput({ context: { mode: 'fixed', tokens: 16384 } })).toEqual({
      context: { mode: 'fixed', tokens: 16384 },
    });
  });

  it.each([
    { context: { mode: 'fixed', tokens: 8192 } },
    { context: { mode: 'fixed' } },
    { context: { mode: 'auto', maxTokens: 50000 } },
    { context: 'auto' },
    { draftTokens: 17 },
    { draftTokens: 1.5 },
    { draftTokens: -1 },
    { keepAlive: 60 },
    { keepAlive: '1h' },
    { generation: { temperature: 0.5 }, keepAlive: 7 },
  ])('rejects %j', raw => {
    expect(parseModelSettingsInput(raw)).toBeNull();
  });

  it('keeps the valid load fields of a stored entry and drops the rest', () => {
    expect(
      normalizeModelSettings({ context: { mode: 'fixed', tokens: 1000 }, draftTokens: 2, keepAlive: 3600 })
    ).toEqual({ draftTokens: 2, keepAlive: 3600 });
    expect(normalizeModelSettings({ context: { mode: 'auto' } })).toEqual({ context: { mode: 'auto' } });
  });
});

describe('normalizeModelSettings', () => {
  it('is undefined once nothing valid is left', () => {
    expect(normalizeModelSettings({ generation: { temperature: -1 }, effort: 'x' })).toBeUndefined();
    expect(normalizeModelSettings({ draftTokens: 99, keepAlive: 2 })).toBeUndefined();
  });
});

describe('isModelSettingsId', () => {
  it('takes device-side model ids only', () => {
    expect(isModelSettingsId(QWEN)).toBe(true);
    expect(isModelSettingsId('gpt-5')).toBe(false);
    expect(isModelSettingsId(7)).toBe(false);
    expect(isModelSettingsId(`local:ollama:${'x'.repeat(2000)}`)).toBe(false);
  });
});
