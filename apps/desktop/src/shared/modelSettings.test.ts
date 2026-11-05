import { describe, expect, it } from 'vitest';
import {
  isModelSettingsId,
  parseModelSettingsFile,
  parseModelSettingsInput,
  storedModelEntry,
  type ModelSettings,
} from './modelSettings';

const QWEN = 'local:ollama:qwen3.8:27b';

function settingsOf(raw: unknown): [string, ModelSettings][] {
  const parsed = parseModelSettingsFile(raw);
  if (!parsed || 'invalid' in parsed) throw new Error(`not read: ${JSON.stringify(parsed)}`);
  return [...parsed.settings];
}

describe('parseModelSettingsFile', () => {
  it('reads known fields, and keeps unknown fields and unrecognized ids as written without reading them', () => {
    const models = JSON.parse(
      `{"${QWEN}": {"generation": {"temperature": 0.6, "bogus": 1}, "effort": "high", "extra": true},
        "claude-sonnet": {"generation": {"temperature": "hot"}},
        "local:ollama:newer": {"futureOnly": 1},
        "__proto__": {"effort": "wild"}}`
    ) as Record<string, unknown>;
    expect(Object.hasOwn(models, '__proto__')).toBe(true);
    const parsed = parseModelSettingsFile({ version: 9, models });
    if (!parsed || 'invalid' in parsed) throw new Error('not read');
    expect([...parsed.settings]).toEqual([[QWEN, { generation: { temperature: 0.6 }, effort: 'high' }]]);
    expect(Object.fromEntries(parsed.entries)).toEqual(models);
    expect(parsed.rest).toEqual({ version: 9 });
  });

  it.each([
    [{ generation: { temperature: '0.6' } }, 'generation.temperature'],
    [{ generation: { topK: 1.5 } }, 'generation.topK'],
    [{ generation: { temperature: null } }, 'generation.temperature'],
    [{ generation: 'warm' }, 'generation'],
    [{ effort: 'wild' }, 'effort'],
    [{ effort: 'default' }, 'effort'],
    [{ context: { mode: 'fixed', tokens: 400 } }, 'context'],
    [{ draftTokens: 99 }, 'draftTokens'],
    [{ keepAlive: 2 }, 'keepAlive'],
    [7, null],
  ])('names the model and the known field of %j that holds a bad value', (entry, field) => {
    expect(parseModelSettingsFile({ models: { 'local:ollama:other': {}, [QWEN]: entry } })).toEqual({
      invalid: { modelId: QWEN, field },
    });
  });

  it.each([null, 'text', [], { models: [] }, { models: 'x' }, {}, { model: {} }])(
    'does not take %j for a file',
    raw => {
      expect(parseModelSettingsFile(raw)).toBeNull();
    }
  );

  it('reads a file with no models as no defaults', () => {
    expect(settingsOf({ models: {} })).toEqual([]);
  });
});

describe('storedModelEntry', () => {
  it('writes the new settings over the known fields and keeps the unknown ones, inside generation too', () => {
    expect(
      storedModelEntry(
        { generation: { temperature: 0.6, bogus: [1] }, effort: 'high', futureOnly: { a: 1 } },
        { generation: { topK: 20 }, keepAlive: -1 }
      )
    ).toEqual({ futureOnly: { a: 1 }, generation: { bogus: [1], topK: 20 }, keepAlive: -1 });
  });

  it('keeps an entry that only holds unknown fields after a clear, and drops one with nothing left', () => {
    expect(storedModelEntry({ effort: 'low', futureOnly: true }, {})).toEqual({ futureOnly: true });
    expect(storedModelEntry({ effort: 'low' }, {})).toBeUndefined();
    expect(storedModelEntry(undefined, { effort: 'low' })).toEqual({ effort: 'low' });
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
  it('keeps a trained length between the offered sizes, and loads a value stored before it was offered', () => {
    expect(parseModelSettingsInput({ context: { mode: 'fixed', tokens: 40960 } })).toEqual({
      context: { mode: 'fixed', tokens: 40960 },
    });
    expect(settingsOf({ models: { [QWEN]: { context: { mode: 'auto', maxTokens: 40960 } } } })).toEqual([
      [QWEN, { context: { mode: 'auto', maxTokens: 40960 } }],
    ]);
    expect(settingsOf({ models: { [QWEN]: { context: { mode: 'fixed', tokens: 65536 } } } })).toEqual([
      [QWEN, { context: { mode: 'fixed', tokens: 65536 } }],
    ]);
  });

  it('accepts a context choice, a draft count and a keep-alive', () => {
    expect(
      parseModelSettingsInput({ context: { mode: 'auto', maxTokens: 65536 }, draftTokens: 0, keepAlive: -1 })
    ).toEqual({ context: { mode: 'auto', maxTokens: 65536 }, draftTokens: 0, keepAlive: -1 });
    expect(parseModelSettingsInput({ context: { mode: 'fixed', tokens: 16384 } })).toEqual({
      context: { mode: 'fixed', tokens: 16384 },
    });
  });

  it('keeps a context below 16K, which a model trained that short is offered', () => {
    expect(parseModelSettingsInput({ context: { mode: 'fixed', tokens: 4096 } })).toEqual({
      context: { mode: 'fixed', tokens: 4096 },
    });
    expect(parseModelSettingsInput({ context: { mode: 'auto', maxTokens: 8192 } })).toEqual({
      context: { mode: 'auto', maxTokens: 8192 },
    });
  });

  it.each([
    { context: { mode: 'fixed', tokens: 256 } },
    { context: { mode: 'auto', maxTokens: 511 } },
    { context: { mode: 'fixed' } },
    { context: { mode: 'auto', maxTokens: 524288 } },
    { context: { mode: 'fixed', tokens: 40960.5 } },
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

  it('reads the load fields of a stored entry', () => {
    expect(settingsOf({ models: { [QWEN]: { draftTokens: 2, keepAlive: 3600 } } })).toEqual([
      [QWEN, { draftTokens: 2, keepAlive: 3600 }],
    ]);
    expect(settingsOf({ models: { [QWEN]: { context: { mode: 'auto' } } } })).toEqual([
      [QWEN, { context: { mode: 'auto' } }],
    ]);
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
