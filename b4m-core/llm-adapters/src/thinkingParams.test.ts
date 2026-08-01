import { describe, it, expect } from 'vitest';
import { ADAPTIVE_THINKING_MAX_TOKENS_FLOOR, buildThinkingParams, resolveOutputMaxTokens } from './thinkingParams';
import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';

const baseModelInfo: ModelInfo = {
  id: ChatModels.CLAUDE_4_6_OPUS,
  type: 'text',
  name: 'Claude 4.6 Opus',
  backend: ModelBackend.Anthropic,
  contextWindow: 1_000_000,
  max_tokens: 128_000,
  can_think: true,
  pricing: { 1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
  supportsImageVariation: false,
};

const legacyModel: ModelInfo = { ...baseModelInfo };

/** GPT-5.6 Sol: a hardcoded OpenAI reasoning model, so REASONING_SUPPORTED_MODELS knows it. */
const openAiReasoningModel: ModelInfo = {
  ...baseModelInfo,
  id: ChatModels.GPT5_6_SOL,
  name: 'GPT-5.6 Sol',
  backend: ModelBackend.OpenAI,
  thinkingStyle: undefined,
};

/** The same shape, but an id no hardcoded set lists - only the dispatch profile identifies it. */
const catalogOnlyReasoningModel: ModelInfo = {
  ...baseModelInfo,
  id: 'some-unlisted-reasoning-model' as ModelInfo['id'],
  name: 'Unlisted reasoning model',
  backend: ModelBackend.OpenAI,
  thinkingStyle: undefined,
  can_think: true,
  dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
};
const adaptiveModel: ModelInfo = {
  ...baseModelInfo,
  id: ChatModels.CLAUDE_4_7_OPUS,
  name: 'Claude 4.7 Opus',
  thinkingStyle: 'adaptive',
};

describe('buildThinkingParams', () => {
  describe('legacy models (thinkingStyle unset or "legacy")', () => {
    it('returns type "enabled" with budget_tokens', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect(result.thinkingConfig.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('does not include output_config', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect('output_config' in result.thinkingConfig).toBe(false);
    });

    it('inflates max_tokens to budget + 1000', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect(result.maxTokens).toBe(17000);
    });

    it('keeps caller max_tokens when already larger than budget + 1000', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 8000, 32000);
      expect(result.maxTokens).toBe(32000);
    });

    it('sets temperature to 1 for normal models', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect(result.temperature).toBe(1);
    });
  });

  describe('adaptive models (thinkingStyle: "adaptive")', () => {
    it('returns type "adaptive" without budget_tokens', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect(result.thinkingConfig.thinking).toEqual({ type: 'adaptive' });
    });

    it('includes output_config with effort', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect((result.thinkingConfig as { output_config: { effort: string } }).output_config).toEqual({
        effort: 'high',
      });
    });

    it('uses custom effort level', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096, 'medium');
      expect((result.thinkingConfig as { output_config: { effort: string } }).output_config).toEqual({
        effort: 'medium',
      });
    });

    it('applies 64K max_tokens floor', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect(result.maxTokens).toBe(64_000);
    });

    it('keeps caller max_tokens when already above 64K floor', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 100000);
      expect(result.maxTokens).toBe(100000);
    });

    it('returns temperature "delete" for NO_TEMPERATURE_MODELS', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect(result.temperature).toBe('delete');
    });
  });
});

describe('resolveOutputMaxTokens', () => {
  const resolve = (requested: number | undefined, modelInfo: ModelInfo) =>
    resolveOutputMaxTokens({
      requested,
      fallback: 4096,
      modelInfo,
      modelMaxOutputTokens: modelInfo.max_tokens,
    });

  describe('an explicit caller budget is never raised', () => {
    // The bug this guards: flooring adaptive models unconditionally silently
    // multiplied a caller's stated budget, which also inflates the credit
    // pre-reservation and shrinks the usable input window.
    it('honors a budget below the adaptive floor on an adaptive model', () => {
      expect(resolve(16_000, adaptiveModel)).toBe(16_000);
    });

    it('honors a tiny budget on an adaptive model', () => {
      expect(resolve(50, adaptiveModel)).toBe(50);
    });

    it('honors a budget on a legacy model', () => {
      expect(resolve(16_000, legacyModel)).toBe(16_000);
    });

    it('honors a budget on an OpenAI reasoning model', () => {
      expect(resolve(16_000, openAiReasoningModel)).toBe(16_000);
    });
  });

  describe('absence is sized for the model', () => {
    it('defaults an adaptive model to the shared floor', () => {
      expect(resolve(undefined, adaptiveModel)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    it('defaults a legacy model to the caller-supplied fallback', () => {
      expect(resolve(undefined, legacyModel)).toBe(4096);
    });

    // The starvation this fixes: OpenAI spends reasoning inside max_completion_tokens,
    // so a 4096 default was consumed entirely by reasoning and the turn came back empty.
    it('defaults an OpenAI reasoning model to the shared floor', () => {
      expect(resolve(undefined, openAiReasoningModel)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    // Catalog-only reasoning models are not in any hardcoded set, so the reasoning-shaped
    // max-tokens param plus can_think has to carry them.
    it('defaults an unlisted but reasoning-shaped catalog model to the shared floor', () => {
      expect(resolve(undefined, catalogOnlyReasoningModel)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    // can_think alone must not trigger headroom: legacy thinking is opt-in and
    // separately budgeted, so these models would pay for room they never use.
    it('does not give a non-reasoning-shaped model the floor merely for can_think', () => {
      expect(resolve(undefined, { ...legacyModel, can_think: true })).toBe(4096);
    });
  });

  describe('clamps to the model output cap', () => {
    it('clamps an over-large explicit budget', () => {
      expect(resolve(500_000, legacyModel)).toBe(128_000);
    });

    // Over-requesting 400s the whole turn, so the adaptive default must yield to a
    // model whose own cap is smaller than the floor.
    it('clamps the adaptive default on a model capped below the floor', () => {
      const smallCap: ModelInfo = { ...adaptiveModel, max_tokens: 8192 };
      expect(resolve(undefined, smallCap)).toBe(8192);
    });
  });
});
