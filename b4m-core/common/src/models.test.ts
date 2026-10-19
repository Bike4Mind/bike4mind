import { describe, expect, it } from 'vitest';
import {
  ChatModels,
  REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS,
  REASONING_SUPPORTED_MODELS,
  SERVABLE_CHAT_MODELS,
  supportedChatModels,
} from './models';
import { settingsMap } from './schemas/settings';

describe('gpt-5.4-mini dated snapshot', () => {
  it('is a ChatModels member beside the unchanged alias', () => {
    expect(ChatModels.GPT5_4_MINI_2026_03_17).toBe('gpt-5.4-mini-2026-03-17');
    expect(ChatModels.GPT5_4_MINI).toBe('gpt-5.4-mini');
  });

  it('is rejected by supportedChatModels until it has a catalog row', () => {
    expect(supportedChatModels.safeParse(ChatModels.GPT5_4_MINI_2026_03_17).success).toBe(false);
    expect(supportedChatModels.safeParse(ChatModels.GPT5_4_MINI).success).toBe(true);
  });

  it('is absent from SERVABLE_CHAT_MODELS, which integration-status checks the configured model against', () => {
    expect(SERVABLE_CHAT_MODELS).not.toContain(ChatModels.GPT5_4_MINI_2026_03_17);
    expect(SERVABLE_CHAT_MODELS).toContain(ChatModels.GPT5_4_MINI);
  });

  it('matches the alias in the reasoning sets', () => {
    expect(REASONING_SUPPORTED_MODELS.has(ChatModels.GPT5_4_MINI_2026_03_17)).toBe(true);
    expect(REASONING_EFFORT_INCOMPATIBLE_WITH_TOOLS_MODELS.has(ChatModels.GPT5_4_MINI_2026_03_17)).toBe(true);
  });

  it.each(['DefaultAPIModel', 'EmailAnalysisModel'] as const)(
    '%s setting rejects the snapshot and accepts the alias',
    key => {
      expect(settingsMap[key].schema.safeParse(ChatModels.GPT5_4_MINI_2026_03_17).success).toBe(false);
      expect(settingsMap[key].schema.safeParse(ChatModels.GPT5_4_MINI).success).toBe(true);
    }
  );
});
