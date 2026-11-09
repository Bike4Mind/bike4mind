// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { isThinkingShownActive, offersReasoningEffort, thinkingForSend } from './thinkingPayload';

const ON = { enabled: true, budget_tokens: 16000 };
const OFF = { enabled: false, budget_tokens: 16000 };
const ALWAYS_ON_ADAPTIVE = { thinkingAlwaysOn: true as const, thinkingStyle: 'adaptive' as const };
const ALWAYS_ON_KIMI = { thinkingAlwaysOn: true as const };
const SWITCHABLE = { thinkingStyle: 'adaptive' as const };

describe('thinkingForSend', () => {
  it('drops a stored toggle for a model whose thinking is always on', () => {
    expect(thinkingForSend(ON, ALWAYS_ON_ADAPTIVE)).toBeUndefined();
    expect(thinkingForSend(OFF, ALWAYS_ON_KIMI)).toBeUndefined();
  });

  it('passes the toggle through for a switchable model or an unresolved one', () => {
    expect(thinkingForSend(ON, SWITCHABLE)).toBe(ON);
    expect(thinkingForSend(OFF, undefined)).toBe(OFF);
  });
});

describe('isThinkingShownActive', () => {
  it('reads active for an always-on model even with the toggle off', () => {
    expect(isThinkingShownActive(OFF, ALWAYS_ON_ADAPTIVE)).toBe(true);
    expect(isThinkingShownActive(undefined, ALWAYS_ON_KIMI)).toBe(true);
  });

  it('follows the toggle otherwise', () => {
    expect(isThinkingShownActive(ON, SWITCHABLE)).toBe(true);
    expect(isThinkingShownActive(OFF, SWITCHABLE)).toBe(false);
    expect(isThinkingShownActive(undefined, undefined)).toBe(false);
  });
});

describe('offersReasoningEffort', () => {
  it('offers it for an always-on adaptive Claude model and the OpenAI reasoning models', () => {
    expect(offersReasoningEffort(ChatModels.CLAUDE_5_5_OPUS, ALWAYS_ON_ADAPTIVE)).toBe(true);
    expect(offersReasoningEffort(ChatModels.GPT5_6_SOL, undefined)).toBe(true);
  });

  it('does not offer it for a switchable Claude model or an always-on Kimi model', () => {
    expect(offersReasoningEffort(ChatModels.CLAUDE_5_OPUS, SWITCHABLE)).toBe(false);
    expect(offersReasoningEffort(ChatModels.KIMI_K2_7_CODE, ALWAYS_ON_KIMI)).toBe(false);
  });
});
