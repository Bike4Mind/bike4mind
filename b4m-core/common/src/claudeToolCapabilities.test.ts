import { describe, expect, it } from 'vitest';
import { supportsToolChanges, supportsToolSearch } from './claudeToolCapabilities';
import { CHAT_MODELS, ChatModels, isClaudeModelId, ModelBackend } from './models';

// [tool search, tool changes]. Every Claude id in ChatModels must be listed, so a new one forces a decision.
const EXPECTED: Record<string, [boolean, boolean]> = {
  [ChatModels.CLAUDE_3_HAIKU_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_3_5_HAIKU_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_3_5_SONNET_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_4_OPUS_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_4_1_OPUS_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_4_SONNET_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_3_5_SONNET_V2_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_3_7_SONNET_BEDROCK]: [false, false],
  [ChatModels.CLAUDE_4_5_SONNET_BEDROCK]: [true, false],
  [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: [true, false],
  [ChatModels.CLAUDE_4_5_OPUS_BEDROCK]: [true, false],
  [ChatModels.CLAUDE_4_6_SONNET_BEDROCK]: [true, false],
  [ChatModels.CLAUDE_5_SONNET_BEDROCK]: [true, false],
  [ChatModels.CLAUDE_5_5_SONNET_BEDROCK]: [true, true],
  [ChatModels.CLAUDE_4_6_OPUS_BEDROCK]: [true, false],
  [ChatModels.CLAUDE_4_7_OPUS_BEDROCK]: [true, false],
  [ChatModels.CLAUDE_4_8_OPUS_BEDROCK]: [true, true],
  [ChatModels.CLAUDE_FABLE_5_BEDROCK]: [true, true],
  [ChatModels.CLAUDE_FABLE_5_1_BEDROCK]: [true, true],
  [ChatModels.CLAUDE_5_OPUS_BEDROCK]: [true, true],
  [ChatModels.CLAUDE_5_5_OPUS_BEDROCK]: [true, true],
  [ChatModels.CLAUDE_5_5_HAIKU_BEDROCK]: [true, true],
  [ChatModels.CLAUDE_3_OPUS]: [false, false],
  [ChatModels.CLAUDE_3_5_HAIKU_ANTHROPIC]: [false, false],
  [ChatModels.CLAUDE_3_5_SONNET_ANTHROPIC]: [false, false],
  [ChatModels.CLAUDE_3_7_SONNET_ANTHROPIC]: [false, false],
  [ChatModels.CLAUDE_4_OPUS]: [false, false],
  [ChatModels.CLAUDE_4_1_OPUS]: [false, false],
  [ChatModels.CLAUDE_4_SONNET]: [false, false],
  [ChatModels.CLAUDE_4_5_SONNET]: [true, false],
  [ChatModels.CLAUDE_4_5_HAIKU]: [true, false],
  [ChatModels.CLAUDE_4_5_OPUS]: [true, false],
  [ChatModels.CLAUDE_4_6_SONNET]: [true, false],
  [ChatModels.CLAUDE_5_SONNET]: [true, false],
  [ChatModels.CLAUDE_4_6_OPUS]: [true, false],
  [ChatModels.CLAUDE_4_7_OPUS]: [true, false],
  [ChatModels.CLAUDE_4_8_OPUS]: [true, true],
  [ChatModels.CLAUDE_FABLE_5]: [true, true],
  [ChatModels.CLAUDE_5_OPUS]: [true, true],
  [ChatModels.CLAUDE_5_5_OPUS]: [true, true],
  [ChatModels.CLAUDE_5_5_HAIKU]: [true, true],
};

const nativeBackend = (id: string) => (id.includes('anthropic.') ? ModelBackend.Bedrock : ModelBackend.Anthropic);
const flags = (id: string, backend = nativeBackend(id)) => [
  supportsToolSearch({ id, backend }),
  supportsToolChanges({ id, backend }),
];

describe('supportsToolSearch / supportsToolChanges', () => {
  it('classifies every Claude id in ChatModels explicitly', () => {
    const claudeIds = CHAT_MODELS.filter(isClaudeModelId);

    expect(Object.keys(EXPECTED).sort()).toEqual([...claudeIds].sort());
    for (const id of claudeIds) expect(flags(id), id).toEqual(EXPECTED[id]);
  });

  it.each([
    ['claude-mythos-5-1', [true, true]],
    ['claude-mythos-5', [true, true]],
    ['claude-fable-5-1', [true, true]],
    ['claude-sonnet-5-5', [true, true]],
    ['claude-opus-4-7-20260416', [true, false]],
    ['claude-opus-5-5[1m]', [true, true]],
    ['anthropic.claude-opus-4-8', [true, true]],
    ['eu.anthropic.claude-haiku-4-5-20251001-v1:0', [true, false]],
    ['apac.anthropic.claude-sonnet-5', [true, false]],
    ['jp.anthropic.claude-opus-4-8', [true, true]],
    ['us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0', [true, false]],
    ['claude-opus-4-5-latest', [true, false]],
    ['claude-3-5-sonnet-latest', [false, false]],
    ['claude-opus-4-1', [false, false]],
    ['us.anthropic.claude-opus-4-20250514-v1:0', [false, false]],
    ['anthropic.claude-v2:1', [false, false]],
    ['claude-mythos-preview', [false, false]],
    ['claude-opus-6', [false, false]],
    ['claude-nova-5', [false, false]],
    ['claude-opus-5-50', [false, false]],
    ['claude-opus-5-5-1', [false, false]],
    ['claude-sonnet-4-5-2025', [false, false]],
    ['anthropic/claude-opus-5-5', [false, false]],
  ])('classifies catalog-only and unseen id %s', (id, expected) => {
    expect(flags(id)).toEqual(expected);
  });

  it('is false for a supported Claude id served by any backend but Anthropic or Bedrock', () => {
    expect(flags(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.OpenAI)).toEqual([false, false]);
    expect(flags(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Ollama)).toEqual([false, false]);
  });

  it('is false for non-Claude models', () => {
    expect(flags(ChatModels.GPT4o, ModelBackend.OpenAI)).toEqual([false, false]);
    expect(flags(ChatModels.GEMINI_2_5_PRO, ModelBackend.Gemini)).toEqual([false, false]);
    expect(flags(ChatModels.DEEPSEEK_R1_BEDROCK, ModelBackend.Bedrock)).toEqual([false, false]);
  });
});
