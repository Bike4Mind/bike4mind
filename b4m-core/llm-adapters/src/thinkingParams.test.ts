import { describe, it, expect } from 'vitest';
import { buildThinkingParams } from './thinkingParams';
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
