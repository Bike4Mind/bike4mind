import { describe, expect, it } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { canonicalModelKey, dedupeModelsForPicker } from './pickerModelDedupe';

const model = (id: string, backend: ModelBackend, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, name: id, backend, type: 'text', contextWindow: 1000, max_tokens: 100, ...extra }) as unknown as ModelInfo;

const ids = (models: ModelInfo[]) => models.map(m => m.id);
const none = new Set<string>();

describe('canonicalModelKey', () => {
  it('folds Bedrock inference profiles, version and date suffixes onto the foundation model', () => {
    expect(canonicalModelKey(model('global.anthropic.claude-opus-5-5', ModelBackend.Bedrock))).toBe(
      'bedrock:anthropic.claude-opus-5-5'
    );
    expect(canonicalModelKey(model('anthropic.claude-opus-5-5', ModelBackend.Bedrock))).toBe(
      'bedrock:anthropic.claude-opus-5-5'
    );
    expect(canonicalModelKey(model('us.anthropic.claude-haiku-4-5-20251001-v1:0', ModelBackend.Bedrock))).toBe(
      'bedrock:anthropic.claude-haiku-4-5'
    );
    expect(canonicalModelKey(model('gpt-4.1-2025-04-14', ModelBackend.OpenAI))).toBe('openai:gpt-4.1');
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
});
