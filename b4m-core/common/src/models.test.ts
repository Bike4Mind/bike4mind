import { describe, expect, it } from 'vitest';
import {
  CHAT_MODELS,
  ChatModels,
  REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS,
  REASONING_SUPPORTED_MODELS,
  supportedChatModels,
} from './models';
import { settingsMap } from './schemas/settings';

describe('gpt-5.4-mini dated snapshot', () => {
  it('CHAT_MODELS excludes the snapshot', () => {
    expect(ChatModels.GPT5_4_MINI_2026_03_17).toBe('gpt-5.4-mini-2026-03-17');
    expect(CHAT_MODELS).not.toContain(ChatModels.GPT5_4_MINI_2026_03_17);
    expect(CHAT_MODELS).toContain(ChatModels.GPT5_4_MINI);
  });

  it('is a ChatModels member beside the unchanged alias', () => {
    expect(ChatModels.GPT5_4_MINI_2026_03_17).toBe('gpt-5.4-mini-2026-03-17');
    expect(ChatModels.GPT5_4_MINI).toBe('gpt-5.4-mini');
  });

  it('is rejected by supportedChatModels until it has a catalog row', () => {
    expect(ChatModels.GPT5_4_MINI_2026_03_17).toBe('gpt-5.4-mini-2026-03-17');
    expect(supportedChatModels.safeParse(ChatModels.GPT5_4_MINI_2026_03_17).success).toBe(false);
    expect(supportedChatModels.safeParse(ChatModels.GPT5_4_MINI).success).toBe(true);
  });

  it('is in the same reasoning sets as the alias', () => {
    expect(ChatModels.GPT5_4_MINI_2026_03_17).toBe('gpt-5.4-mini-2026-03-17');
    for (const set of [REASONING_SUPPORTED_MODELS, REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS]) {
      expect(set.has(ChatModels.GPT5_4_MINI_2026_03_17)).toBe(true);
      expect(set.has(ChatModels.GPT5_4_MINI)).toBe(true);
    }
  });

  it.each(['DefaultAPIModel', 'EmailAnalysisModel'] as const)(
    '%s setting rejects the snapshot and accepts the alias',
    key => {
      expect(ChatModels.GPT5_4_MINI_2026_03_17).toBe('gpt-5.4-mini-2026-03-17');
      expect(settingsMap[key].schema.safeParse(ChatModels.GPT5_4_MINI_2026_03_17).success).toBe(false);
      expect(settingsMap[key].schema.safeParse(ChatModels.GPT5_4_MINI).success).toBe(true);
    }
  );
});
