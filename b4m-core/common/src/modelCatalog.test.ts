import { describe, it, expect } from 'vitest';
import { DEFAULT_MAX_OUTPUT_TOKENS, isRenderableModelType, toModelInfo } from './modelCatalog';
import type { RenderableModelRecord } from './modelCatalog';
import { ModelBackend } from './models';

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

  it('passes lifecycle deprecation through and infers nothing else', () => {
    expect(
      toModelInfo({ ...minimal, lifecycle: { status: 'deprecated', deprecationDate: '2026-09-01' } })
    ).toMatchObject({ deprecationDate: '2026-09-01' });
    expect(toModelInfo({ ...minimal, lifecycle: { status: 'active' } }).deprecationDate).toBeUndefined();
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
