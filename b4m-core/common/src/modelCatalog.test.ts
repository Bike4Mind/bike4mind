import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  inferVendor,
  isRenderableModelType,
  toModelInfo,
  toModelRecord,
} from './modelCatalog';
import type { RenderableModelRecord } from './modelCatalog';
import { ModelBackend } from './models';
import type { ModelInfo } from './models';

const minimal: RenderableModelRecord = {
  id: 'gpt-x',
  vendor: 'openai',
  backend: ModelBackend.OpenAI,
  type: 'text',
  name: 'GPT X',
  contextWindow: 128_000,
};

describe('toModelInfo', () => {
  it('fills every silent field with its documented safe default', () => {
    expect(toModelInfo(minimal)).toEqual({
      id: 'gpt-x',
      type: 'text',
      name: 'GPT X',
      backend: ModelBackend.OpenAI,
      contextWindow: 128_000,
      max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      pricing: {},
      can_stream: undefined,
      can_think: false,
      thinkingStyle: undefined,
      supportsVision: undefined,
      supportsTools: undefined,
      supportsImageVariation: false,
      supportsSafetyTolerance: undefined,
      freeToRun: undefined,
      private: false,
      disabled: false,
      disabledReason: undefined,
      deprecationDate: undefined,
      trainingCutoff: undefined,
      releaseDate: undefined,
      logoFile: undefined,
      rank: undefined,
      description: undefined,
      isSlowModel: undefined,
    });
  });

  it('never caps max_tokens above the context window', () => {
    expect(toModelInfo({ ...minimal, contextWindow: 2048 }).max_tokens).toBe(2048);
    expect(toModelInfo({ ...minimal, maxOutputTokens: 64_000 }).max_tokens).toBe(64_000);
  });

  it('derives can_think and thinkingStyle from the unified reasoning field', () => {
    expect(toModelInfo({ ...minimal, reasoning: { supported: true, style: 'anthropic-adaptive' } })).toMatchObject({
      can_think: true,
      thinkingStyle: 'adaptive',
    });
    expect(toModelInfo({ ...minimal, reasoning: { supported: true, style: 'anthropic-legacy' } })).toMatchObject({
      thinkingStyle: 'legacy',
    });
    // A non-Anthropic style has no ModelInfo spelling; unset lets the backend decide.
    expect(toModelInfo({ ...minimal, reasoning: { supported: true, style: 'openai-effort' } })).toMatchObject({
      can_think: true,
      thinkingStyle: undefined,
    });
  });

  it('treats either owner as able to disable, and reports the matching reason', () => {
    expect(toModelInfo({ ...minimal, autoDisabled: true, autoDisabledReason: 'awaiting price' })).toMatchObject({
      disabled: true,
      disabledReason: 'awaiting price',
    });
    expect(
      toModelInfo({
        ...minimal,
        disabled: true,
        disabledReason: 'contract expired',
        autoDisabled: true,
        autoDisabledReason: 'awaiting price',
      })
    ).toMatchObject({ disabled: true, disabledReason: 'contract expired' });
  });

  it('disables a retired model even with no date to hide it by', () => {
    expect(toModelInfo({ ...minimal, lifecycle: { status: 'retired' } })).toMatchObject({
      disabled: true,
      disabledReason: 'retired by the provider',
    });
    // Deprecated is still callable: the date, once past, is what hides it.
    expect(toModelInfo({ ...minimal, lifecycle: { status: 'deprecated' } }).disabled).toBe(false);
  });

  it('passes lifecycle deprecation through and infers nothing else', () => {
    expect(
      toModelInfo({ ...minimal, lifecycle: { status: 'deprecated', deprecationDate: '2026-09-01' } })
    ).toMatchObject({ deprecationDate: '2026-09-01' });
    expect(toModelInfo({ ...minimal, lifecycle: { status: 'active' } }).deprecationDate).toBeUndefined();
  });
});

describe('toModelRecord', () => {
  const info: ModelInfo = {
    id: 'gpt-x',
    type: 'text',
    name: 'GPT X',
    backend: ModelBackend.OpenAI,
    contextWindow: 128_000,
    max_tokens: 32_000,
    pricing: { 128_000: { input: 1e-6, output: 2e-6 } },
    supportsImageVariation: false,
    can_think: true,
    thinkingStyle: 'adaptive',
    rank: 3,
  };

  it('round-trips back to the same ModelInfo, pricing excepted', () => {
    // Pricing has no catalog home: applyModelPriceCatalog is its only writer.
    expect(toModelInfo(toModelRecord(info))).toEqual({ ...info, pricing: {}, private: false, disabled: false });
  });

  it('never guesses dispatch data, which no ModelInfo field can supply', () => {
    const record = toModelRecord(info);
    expect(record.adapterFamily).toBeUndefined();
    expect(record.dispatchProfile).toBeUndefined();
  });

  it('says nothing about reasoning when the source did not', () => {
    const { can_think: _think, thinkingStyle: _style, ...silent } = info;
    expect(toModelRecord(silent).reasoning).toBeUndefined();
    expect(toModelRecord(info).reasoning).toEqual({ supported: true, style: 'anthropic-adaptive' });
  });

  it('records a deprecation date as a deprecated lifecycle and nothing else as active', () => {
    expect(toModelRecord({ ...info, deprecationDate: '2026-01-01' }).lifecycle).toEqual({
      status: 'deprecated',
      deprecationDate: '2026-01-01',
    });
    expect(toModelRecord(info).lifecycle).toEqual({ status: 'active' });
  });
});

describe('inferVendor', () => {
  it('answers from the backend for direct providers', () => {
    expect(inferVendor({ id: 'gpt-x', backend: ModelBackend.OpenAI })).toBe('openai');
    expect(inferVendor({ id: 'gemini-x', backend: ModelBackend.Gemini })).toBe('google');
  });

  it('answers from the id namespace for Bedrock, past any region prefix', () => {
    expect(inferVendor({ id: 'anthropic.claude-3-haiku-20240307-v1:0', backend: ModelBackend.Bedrock })).toBe(
      'anthropic'
    );
    expect(inferVendor({ id: 'us.meta.llama4-scout-17b-instruct-v1:0', backend: ModelBackend.Bedrock })).toBe('meta');
    expect(inferVendor({ id: 'global.anthropic.claude-opus-4-6-v1', backend: ModelBackend.Bedrock })).toBe('anthropic');
  });
});

describe('isRenderableModelType', () => {
  it('accepts the types this build narrows on and rejects the rest', () => {
    expect(isRenderableModelType('text')).toBe(true);
    expect(isRenderableModelType('video')).toBe(true);
    expect(isRenderableModelType('embedding')).toBe(false);
    expect(isRenderableModelType('realtime-voice')).toBe(false);
  });
});
