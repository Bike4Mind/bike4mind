import { describe, it, expect } from 'vitest';
import { ChatModels } from '../models';
import { tokenEstimateMultiplier } from './tokenEstimateMultiplier';

describe('tokenEstimateMultiplier', () => {
  it.each([
    ChatModels.CLAUDE_5_SONNET,
    ChatModels.CLAUDE_5_SONNET_BEDROCK,
    ChatModels.CLAUDE_5_OPUS,
    ChatModels.CLAUDE_5_5_OPUS,
    ChatModels.CLAUDE_4_7_OPUS,
    ChatModels.CLAUDE_4_7_OPUS_BEDROCK,
    ChatModels.CLAUDE_4_8_OPUS,
    ChatModels.CLAUDE_4_8_OPUS_BEDROCK,
    'claude-sonnet-5-5',
    'global.anthropic.claude-sonnet-5-5',
  ])('scales the newest Claude tokenizer generation by 1.5 (%s)', modelId => {
    expect(tokenEstimateMultiplier(modelId)).toBe(1.5);
  });

  it.each([
    ChatModels.CLAUDE_4_5_SONNET,
    ChatModels.CLAUDE_4_5_SONNET_BEDROCK,
    ChatModels.CLAUDE_4_5_HAIKU,
    ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
    ChatModels.CLAUDE_4_5_OPUS,
    ChatModels.CLAUDE_4_5_OPUS_BEDROCK,
    ChatModels.CLAUDE_4_6_SONNET,
    ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
    ChatModels.CLAUDE_4_6_OPUS,
    ChatModels.CLAUDE_4_6_OPUS_BEDROCK,
  ])('scales the 4.5/4.6 generation by 1.09 (%s)', modelId => {
    expect(tokenEstimateMultiplier(modelId)).toBe(1.09);
  });

  it.each([
    ChatModels.CLAUDE_4_SONNET,
    ChatModels.CLAUDE_4_SONNET_BEDROCK,
    ChatModels.CLAUDE_4_1_OPUS,
    ChatModels.CLAUDE_3_7_SONNET_BEDROCK,
    ChatModels.CLAUDE_3_HAIKU_BEDROCK,
    ChatModels.CLAUDE_FABLE_5,
    'gpt-5.5',
    'gemini-2.5-pro',
    undefined,
  ])('leaves unmeasured models uncalibrated (%s)', modelId => {
    expect(tokenEstimateMultiplier(modelId)).toBe(1);
  });

  it('does not read a date suffix as a minor version', () => {
    expect(tokenEstimateMultiplier('claude-opus-4-20250514')).toBe(1);
  });
});
