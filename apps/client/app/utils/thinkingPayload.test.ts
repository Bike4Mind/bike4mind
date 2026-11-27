// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isThinkingShownActive, thinkingForSend } from './thinkingPayload';

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
