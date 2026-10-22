import { describe, expect, it } from 'vitest';
import { ChatModels, type ModelInfo } from '@bike4mind/common';
import { sentMaxTokensFor } from './modelSizing';

const legacyModel = {
  id: ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
  backend: 'bedrock',
  type: 'text',
  can_think: true,
  thinkingStyle: 'legacy',
} as ModelInfo;

describe('sentMaxTokensFor', () => {
  it.each([undefined, null, { enabled: false }])(
    'preserves the requested ceiling when thinking is off: %j',
    thinking => {
      expect(sentMaxTokensFor(legacyModel, thinking, 4_096)).toBe(4_096);
    }
  );

  it('adds answer room to a legacy thinking budget, with the same default on both consumers', () => {
    expect(sentMaxTokensFor(legacyModel, { enabled: true, budget_tokens: 32_000 }, 4_096)).toBe(33_000);
    expect(sentMaxTokensFor(legacyModel, { enabled: true }, 4_096)).toBe(17_000);
    expect(sentMaxTokensFor(legacyModel, { enabled: true }, 40_000)).toBe(40_000);
  });

  it('reserves the adaptive thinking floor', () => {
    expect(sentMaxTokensFor({ ...legacyModel, thinkingStyle: 'adaptive' }, { enabled: true }, 4_096)).toBe(64_000);
  });

  it('does not raise a model that cannot think or a non-Anthropic adapter', () => {
    expect(sentMaxTokensFor({ ...legacyModel, can_think: false }, { enabled: true }, 4_096)).toBe(4_096);
    const openaiModel = { ...legacyModel, id: ChatModels.GPT5_4_MINI, backend: 'openai' } as ModelInfo;
    expect(sentMaxTokensFor(openaiModel, { enabled: true }, 4_096)).toBe(4_096);
  });
});
