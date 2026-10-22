import { describe, expect, it } from 'vitest';
import {
  CHAT_MODELS,
  ChatModels,
  isClaudeModelId,
  REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS,
  REASONING_SUPPORTED_MODELS,
  supportedChatModels,
} from './models';
import { settingsMap } from './schemas/settings';

describe('isClaudeModelId', () => {
  it.each([
    ChatModels.CLAUDE_5_SONNET,
    ChatModels.CLAUDE_5_5_OPUS,
    ChatModels.CLAUDE_3_HAIKU_BEDROCK,
    ChatModels.CLAUDE_4_SONNET_BEDROCK,
    ChatModels.CLAUDE_5_5_SONNET_BEDROCK,
    'us-gov.anthropic.claude-3-5-sonnet-20240620-v1:0',
  ])('matches %s', id => {
    expect(isClaudeModelId(id)).toBe(true);
  });

  it.each([ChatModels.GPT5, 'gemini-3.5-flash', 'us.deepseek.r1-v1:0', 'moonshot.kimi-k2-thinking'])(
    'does not match %s',
    id => {
      expect(isClaudeModelId(id)).toBe(false);
    }
  );
});

describe('gpt-5.4-mini dated snapshot', () => {
  it('CHAT_MODELS excludes the snapshot', () => {
    expect(CHAT_MODELS).not.toContain(ChatModels.GPT5_4_MINI_2026_03_17);
    expect(CHAT_MODELS).toContain(ChatModels.GPT5_4_MINI);
  });

  it('is a ChatModels member beside the unchanged alias', () => {
    expect(ChatModels.GPT5_4_MINI_2026_03_17).toBe('gpt-5.4-mini-2026-03-17');
    expect(ChatModels.GPT5_4_MINI).toBe('gpt-5.4-mini');
  });

  it('is rejected by supportedChatModels until it has a catalog row', () => {
    expect(supportedChatModels.safeParse(ChatModels.GPT5_4_MINI_2026_03_17).success).toBe(false);
    expect(supportedChatModels.safeParse(ChatModels.GPT5_4_MINI).success).toBe(true);
  });

  it('is in the same reasoning sets as the alias', () => {
    for (const set of [REASONING_SUPPORTED_MODELS, REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS]) {
      expect(set.has(ChatModels.GPT5_4_MINI_2026_03_17)).toBe(true);
      expect(set.has(ChatModels.GPT5_4_MINI)).toBe(true);
    }
  });

  it.each(['DefaultAPIModel', 'EmailAnalysisModel'] as const)(
    '%s setting rejects the snapshot and accepts the alias',
    key => {
      expect(settingsMap[key].schema.safeParse(ChatModels.GPT5_4_MINI_2026_03_17).success).toBe(false);
      expect(settingsMap[key].schema.safeParse(ChatModels.GPT5_4_MINI).success).toBe(true);
    }
  );
});
