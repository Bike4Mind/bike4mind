import { describe, expect, it } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { canonicalModelKey, dedupeModelsForPicker } from './pickerModelDedupe';

const model = (id: string, backend: ModelBackend, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, name: id, backend, type: 'text', contextWindow: 1000, max_tokens: 100, ...extra }) as unknown as ModelInfo;

const ids = (models: ModelInfo[]) => models.map(m => m.id);
const none = new Set<string>();

describe('canonicalModelKey', () => {
  it('folds Bedrock inference profiles onto the foundation model and keeps the release token', () => {
    expect(canonicalModelKey(model('global.anthropic.claude-opus-5-5', ModelBackend.Bedrock))).toBe(
      'bedrock:anthropic.claude-opus-5-5'
    );
    expect(canonicalModelKey(model('anthropic.claude-opus-5-5', ModelBackend.Bedrock))).toBe(
      'bedrock:anthropic.claude-opus-5-5'
    );
    expect(canonicalModelKey(model('us.anthropic.claude-haiku-4-5-20251001-v1:0', ModelBackend.Bedrock))).toBe(
      'bedrock:anthropic.claude-haiku-4-5@20251001'
    );
    expect(canonicalModelKey(model('gpt-4.1-2025-04-14', ModelBackend.OpenAI))).toBe('openai:gpt-4.1@2025-04-14');
  });

  it('gives different releases of one model different keys', () => {
    const key = (id: string, backend: ModelBackend) => canonicalModelKey(model(id, backend));
    expect(key('anthropic.claude-3-5-sonnet-20240620-v1:0', ModelBackend.Bedrock)).not.toBe(
      key('anthropic.claude-3-5-sonnet-20241022-v2:0', ModelBackend.Bedrock)
    );
    expect(key('claude-opus-4-20250514', ModelBackend.Anthropic)).not.toBe(
      key('claude-opus-4-1-20250805', ModelBackend.Anthropic)
    );
  });

  it('keeps the direct and Bedrock routes of one model apart', () => {
    expect(canonicalModelKey(model('claude-opus-5-5', ModelBackend.Anthropic))).not.toBe(
      canonicalModelKey(model('global.anthropic.claude-opus-5-5', ModelBackend.Bedrock))
    );
  });
});

describe('dedupeModelsForPicker', () => {
  it('shows one row per model and drops the unavailable Bedrock foundation twin', () => {
    const models = [
      model('claude-opus-5-5', ModelBackend.Anthropic),
      model('anthropic.claude-opus-5-5', ModelBackend.Bedrock, { disabled: true }),
      model('global.anthropic.claude-opus-5-5', ModelBackend.Bedrock),
      model('gpt-4.1', ModelBackend.OpenAI),
      model('gpt-4.1-2025-04-14', ModelBackend.OpenAI),
    ];
    expect(ids(dedupeModelsForPicker(models, none, ''))).toEqual([
      'claude-opus-5-5',
      'global.anthropic.claude-opus-5-5',
      'gpt-4.1',
    ]);
  });

  it('prefers the inference profile over a bare foundation id when both are enabled', () => {
    const models = [
      model('anthropic.claude-sonnet-5-5', ModelBackend.Bedrock),
      model('global.anthropic.claude-sonnet-5-5', ModelBackend.Bedrock),
    ];
    expect(ids(dedupeModelsForPicker(models, none, ''))).toEqual(['global.anthropic.claude-sonnet-5-5']);
  });

  it('keeps a preferred id even when it is the twin that would otherwise lose', () => {
    const models = [model('gpt-4.1', ModelBackend.OpenAI), model('gpt-4.1-2025-04-14', ModelBackend.OpenAI)];
    expect(ids(dedupeModelsForPicker(models, new Set(['gpt-4.1-2025-04-14']), ''))).toEqual(['gpt-4.1-2025-04-14']);
  });

  it('hides unavailable models unless one is the active selection', () => {
    const models = [
      model('gemini-3.5-flash', ModelBackend.Gemini),
      model('grok-old', ModelBackend.XAI, { disabled: true }),
      model('kimi-old', ModelBackend.Kimi, { disabled: true }),
    ];
    expect(ids(dedupeModelsForPicker(models, none, 'kimi-old'))).toEqual(['gemini-3.5-flash', 'kimi-old']);
  });

  it('drops disabled favorites and recommendations when they are not active', () => {
    const models = [
      model('grok-old', ModelBackend.XAI, { disabled: true }),
      model('kimi-old', ModelBackend.Kimi, { disabled: true }),
    ];
    expect(ids(dedupeModelsForPicker(models, new Set(['grok-old', 'kimi-old']), 'other-model'))).toEqual([]);
  });

  it('keeps a disabled active model alongside its enabled twin', () => {
    const activeId = 'anthropic.claude-opus-5-5';
    const enabledId = 'global.anthropic.claude-opus-5-5';
    const models = [model(activeId, ModelBackend.Bedrock, { disabled: true }), model(enabledId, ModelBackend.Bedrock)];
    expect(ids(dedupeModelsForPicker(models, none, activeId))).toEqual([activeId, enabledId]);
  });

  it('keeps an enabled active model instead of a preferred twin', () => {
    const activeId = 'gpt-4.1';
    const preferredId = 'gpt-4.1-2025-04-14';
    const models = [model(activeId, ModelBackend.OpenAI), model(preferredId, ModelBackend.OpenAI)];
    expect(ids(dedupeModelsForPicker(models, new Set([preferredId]), activeId))).toEqual([activeId]);
  });

  describe('distinct releases', () => {
    it.each([
      [
        'Bedrock',
        ModelBackend.Bedrock,
        ['anthropic.claude-3-5-sonnet-20240620-v1:0', 'anthropic.claude-3-5-sonnet-20241022-v2:0'],
      ],
      ['Anthropic', ModelBackend.Anthropic, ['claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022']],
      ['OpenAI snapshots', ModelBackend.OpenAI, ['gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20']],
      ['Anthropic point releases', ModelBackend.Anthropic, ['claude-opus-4-20250514', 'claude-opus-4-1-20250805']],
    ])('keeps every %s release as its own row in either input order', (_, backend, releaseIds) => {
      const forward = releaseIds.map(id => model(id, backend));
      const reversed = [...forward].reverse();
      expect(ids(dedupeModelsForPicker(forward, none, ''))).toEqual(releaseIds);
      expect(ids(dedupeModelsForPicker(reversed, none, ''))).toEqual([...releaseIds].reverse());
    });

    it('keeps an alias beside its snapshots when the base has more than one release', () => {
      const models = [
        model('gpt-4o', ModelBackend.OpenAI),
        model('gpt-4o-2024-05-13', ModelBackend.OpenAI),
        model('gpt-4o-2024-08-06', ModelBackend.OpenAI),
      ];
      expect(ids(dedupeModelsForPicker(models, none, ''))).toEqual(ids(models));
    });

    it('folds an undated alias into its only snapshot, whichever comes first', () => {
      const alias = model('claude-sonnet-4', ModelBackend.Anthropic);
      const snapshot = model('claude-sonnet-4-20250514', ModelBackend.Anthropic);
      expect(ids(dedupeModelsForPicker([alias, snapshot], none, ''))).toEqual(['claude-sonnet-4']);
      expect(ids(dedupeModelsForPicker([snapshot, alias], none, ''))).toEqual(['claude-sonnet-4']);
    });

    it('folds Bedrock profiles of the same release and keeps the other release apart', () => {
      const models = [
        model('anthropic.claude-3-5-sonnet-20240620-v1:0', ModelBackend.Bedrock),
        model('us.anthropic.claude-3-5-sonnet-20240620-v1:0', ModelBackend.Bedrock),
        model('global.anthropic.claude-3-5-sonnet-20241022-v2:0', ModelBackend.Bedrock),
      ];
      expect(ids(dedupeModelsForPicker(models, none, ''))).toEqual([
        'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
        'global.anthropic.claude-3-5-sonnet-20241022-v2:0',
      ]);
    });

    it('picks the same us or eu profile regardless of input order', () => {
      const us = model('us.anthropic.claude-opus-5-5', ModelBackend.Bedrock);
      const eu = model('eu.anthropic.claude-opus-5-5', ModelBackend.Bedrock);
      expect(ids(dedupeModelsForPicker([us, eu], none, ''))).toEqual(['eu.anthropic.claude-opus-5-5']);
      expect(ids(dedupeModelsForPicker([eu, us], none, ''))).toEqual(['eu.anthropic.claude-opus-5-5']);
    });
  });

  describe('alias suffixes', () => {
    it.each([
      ['gpt-4', 'gpt-4-0613', ModelBackend.OpenAI],
      ['gpt-3.5-turbo', 'gpt-3.5-turbo-0125', ModelBackend.OpenAI],
      ['claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20241022', ModelBackend.Anthropic],
    ])('folds %s into %s when it is the only snapshot', (alias, snapshot, backend) => {
      const models = [model(snapshot, backend), model(alias, backend)];
      expect(ids(dedupeModelsForPicker(models, none, ''))).toEqual([alias]);
    });

    it('keeps -latest apart when two dated snapshots exist', () => {
      const models = [
        model('claude-3-5-sonnet-latest', ModelBackend.Anthropic),
        model('claude-3-5-sonnet-20240620', ModelBackend.Anthropic),
        model('claude-3-5-sonnet-20241022', ModelBackend.Anthropic),
      ];
      expect(ids(dedupeModelsForPicker(models, none, ''))).toEqual(ids(models));
    });

    it.each([
      ['gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro'],
      ['gemini-2.0-flash-001', 'gemini-2.0-flash'],
    ])('does not fold %s into %s', (variant, base) => {
      const models = [model(base, ModelBackend.Gemini), model(variant, ModelBackend.Gemini)];
      expect(ids(dedupeModelsForPicker(models, none, ''))).toEqual([base, variant]);
    });
  });
});
