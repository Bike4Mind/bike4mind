import { ChatModels } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { parseReasoningEffortSetting, reasoningEffortFor } from './reasoningEffort';

describe('parseReasoningEffortSetting', () => {
  it('accepts each documented value, ignoring case and padding', () => {
    expect(parseReasoningEffortSetting(' Minimal ')).toBe('minimal');
    expect(parseReasoningEffortSetting('low')).toBe('low');
    expect(parseReasoningEffortSetting('medium')).toBe('medium');
    expect(parseReasoningEffortSetting('HIGH')).toBe('high');
  });

  it('falls back to default for unset, blank and unknown values', () => {
    expect(parseReasoningEffortSetting(undefined)).toBe('default');
    expect(parseReasoningEffortSetting('')).toBe('default');
    expect(parseReasoningEffortSetting('turbo')).toBe('default');
  });
});

describe('reasoningEffortFor', () => {
  it('sends nothing for default or an absent setting', () => {
    expect(reasoningEffortFor('default', ChatModels.GPT5)).toBeUndefined();
    expect(reasoningEffortFor(undefined, ChatModels.GPT5)).toBeUndefined();
  });

  it('sends the effort to a model that supports it', () => {
    expect(reasoningEffortFor('low', ChatModels.GPT5)).toBe('low');
  });

  it('never sends it to a Claude model', () => {
    expect(reasoningEffortFor('low', ChatModels.CLAUDE_5_OPUS)).toBeUndefined();
  });
});
