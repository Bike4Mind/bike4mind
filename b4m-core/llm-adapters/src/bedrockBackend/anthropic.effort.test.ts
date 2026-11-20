import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';

const backend = new AnthropicBedrockBackend();

function effortOf(model: string, options: Record<string, unknown> = {}): string | undefined {
  const payload = backend.getPayload(model, [{ role: 'user', content: 'go' }], {
    maxTokens: 4096,
    thinking: { enabled: true, budget_tokens: 16000 },
    ...options,
  });
  const body = JSON.parse(payload.body) as { output_config?: { effort?: string } };
  return body.output_config?.effort;
}

describe('AnthropicBedrockBackend output_config.effort default', () => {
  it.each([ChatModels.CLAUDE_5_5_OPUS_BEDROCK, ChatModels.CLAUDE_5_5_HAIKU_BEDROCK])(
    'sends medium for %s when no effort is stated',
    model => {
      expect(effortOf(model)).toBe('medium');
    }
  );

  it.each([ChatModels.CLAUDE_5_OPUS_BEDROCK, ChatModels.CLAUDE_5_5_SONNET_BEDROCK, ChatModels.CLAUDE_4_7_OPUS_BEDROCK])(
    'sends high for %s when no effort is stated',
    model => {
      expect(effortOf(model)).toBe('high');
    }
  );

  it.each(['high', 'xhigh', 'low'] as const)('sends a stated %s on a medium-default model', level => {
    expect(effortOf(ChatModels.CLAUDE_5_5_OPUS_BEDROCK, { anthropicEffort: level })).toBe(level);
    expect(effortOf(ChatModels.CLAUDE_5_5_HAIKU_BEDROCK, { reasoningEffort: level })).toBe(level);
  });

  // No effort leaves these models on the provider's own default, which is medium for them.
  it.each([ChatModels.CLAUDE_5_5_OPUS_BEDROCK, ChatModels.CLAUDE_5_5_HAIKU_BEDROCK])(
    'sends no effort for %s when thinking is not enabled',
    model => {
      expect(effortOf(model, { thinking: undefined })).toBeUndefined();
    }
  );

  it('keeps QuestMaster at medium on a high-default model', () => {
    expect(effortOf(ChatModels.CLAUDE_5_OPUS_BEDROCK, { questMaster: true, thinking: undefined })).toBe('medium');
  });
});
