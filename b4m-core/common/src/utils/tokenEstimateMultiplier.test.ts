import { describe, it, expect } from 'vitest';
import { ChatModels } from '../models';
import { tokenEstimateMultiplier } from './tokenEstimateMultiplier';

// Every Claude id in the catalogue, with the factor it must get. The completeness test below fails when a
// new Claude id lands without a row here, so its bucket is a decision rather than whatever the regex says.
const CLAUDE_CATALOGUE: Array<[ChatModels, number]> = [
  [ChatModels.CLAUDE_5_5_OPUS, 1.5],
  [ChatModels.CLAUDE_5_5_OPUS_BEDROCK, 1.5],
  [ChatModels.CLAUDE_5_OPUS, 1.5],
  [ChatModels.CLAUDE_5_OPUS_BEDROCK, 1.5],
  [ChatModels.CLAUDE_FABLE_5_1_BEDROCK, 1],
  [ChatModels.CLAUDE_5_SONNET, 1.5],
  [ChatModels.CLAUDE_5_SONNET_BEDROCK, 1.5],
  [ChatModels.CLAUDE_5_5_SONNET_BEDROCK, 1.5],
  [ChatModels.CLAUDE_4_8_OPUS, 1.5],
  [ChatModels.CLAUDE_4_8_OPUS_BEDROCK, 1.5],
  [ChatModels.CLAUDE_4_7_OPUS, 1.5],
  [ChatModels.CLAUDE_4_7_OPUS_BEDROCK, 1.5],
  [ChatModels.CLAUDE_4_6_OPUS, 1.09],
  [ChatModels.CLAUDE_4_6_OPUS_BEDROCK, 1.09],
  [ChatModels.CLAUDE_4_6_SONNET, 1.09],
  [ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 1.09],
  [ChatModels.CLAUDE_4_5_OPUS, 1.09],
  [ChatModels.CLAUDE_4_5_OPUS_BEDROCK, 1.09],
  [ChatModels.CLAUDE_4_5_SONNET, 1.09],
  [ChatModels.CLAUDE_4_5_SONNET_BEDROCK, 1.09],
  [ChatModels.CLAUDE_4_5_HAIKU, 1.09],
  [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK, 1.09],
  [ChatModels.CLAUDE_4_1_OPUS, 1],
  [ChatModels.CLAUDE_4_1_OPUS_BEDROCK, 1],
  [ChatModels.CLAUDE_4_OPUS, 1],
  [ChatModels.CLAUDE_4_OPUS_BEDROCK, 1],
  [ChatModels.CLAUDE_4_SONNET, 1],
  [ChatModels.CLAUDE_4_SONNET_BEDROCK, 1],
  [ChatModels.CLAUDE_3_7_SONNET_ANTHROPIC, 1],
  [ChatModels.CLAUDE_3_7_SONNET_BEDROCK, 1],
  [ChatModels.CLAUDE_3_5_SONNET_ANTHROPIC, 1],
  [ChatModels.CLAUDE_3_5_SONNET_BEDROCK, 1],
  [ChatModels.CLAUDE_3_5_SONNET_V2_BEDROCK, 1],
  [ChatModels.CLAUDE_3_5_HAIKU_ANTHROPIC, 1],
  [ChatModels.CLAUDE_3_5_HAIKU_BEDROCK, 1],
  [ChatModels.CLAUDE_3_OPUS, 1],
  [ChatModels.CLAUDE_3_HAIKU_BEDROCK, 1],
  [ChatModels.CLAUDE_FABLE_5, 1],
  [ChatModels.CLAUDE_FABLE_5_BEDROCK, 1],
];

describe('tokenEstimateMultiplier', () => {
  it.each(CLAUDE_CATALOGUE)('maps %s to %s', (modelId, expected) => {
    expect(tokenEstimateMultiplier(modelId)).toBe(expected);
  });

  it('has a row for every Claude id in ChatModels', () => {
    const catalogued = new Set<string>(CLAUDE_CATALOGUE.map(([modelId]) => modelId));
    const claudeIds = Object.values(ChatModels).filter(modelId => modelId.includes('claude'));
    expect(claudeIds.filter(modelId => !catalogued.has(modelId))).toEqual([]);
  });

  it.each(['claude-sonnet-5-5', 'global.anthropic.claude-sonnet-5-5'])(
    'carries the newest factor forward to an uncatalogued release (%s)',
    modelId => {
      expect(tokenEstimateMultiplier(modelId)).toBe(1.5);
    }
  );

  it('compares a two-digit minor as a version, not a decimal', () => {
    expect(tokenEstimateMultiplier('claude-opus-4-10')).toBe(1.5);
    expect(tokenEstimateMultiplier('claude-opus-3-10')).toBe(1);
  });

  it.each(['gpt-5.5', 'gemini-2.5-pro', undefined])('leaves a non-Claude model uncalibrated (%s)', modelId => {
    expect(tokenEstimateMultiplier(modelId)).toBe(1);
  });

  it('does not read a date suffix as a minor version', () => {
    expect(tokenEstimateMultiplier('claude-opus-4-20250514')).toBe(1);
  });
});
