import { describe, it, expect } from 'vitest';
import { ChatModels, isClaudeModelId } from './models';

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
