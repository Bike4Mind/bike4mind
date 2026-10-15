import { ChatModels } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import {
  parseReasoningEffortSetting,
  reasoningEffortFor,
  storedReasoningEffortSetting,
  supportsReasoningEffort,
} from './reasoningEffort';

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

  it('sends it to a Claude model that takes an effort', () => {
    expect(reasoningEffortFor('low', ChatModels.CLAUDE_5_OPUS)).toBe('low');
  });

  it('never sends it to a Claude model that predates effort', () => {
    expect(reasoningEffortFor('low', ChatModels.CLAUDE_4_5_SONNET)).toBeUndefined();
  });
});

describe('storedReasoningEffortSetting', () => {
  it('answers null for a file that carries no setting, so the caller can use its own default', () => {
    expect(storedReasoningEffortSetting(undefined)).toBeNull();
    expect(storedReasoningEffortSetting('turbo')).toBeNull();
    expect(storedReasoningEffortSetting(7)).toBeNull();
  });

  it('keeps an explicit default apart from an absent one', () => {
    expect(storedReasoningEffortSetting('default')).toBe('default');
    expect(storedReasoningEffortSetting('high')).toBe('high');
  });
});

describe('supportsReasoningEffort', () => {
  it('is true for the reasoning models and false for everything else', () => {
    expect(supportsReasoningEffort(ChatModels.GPT5)).toBe(true);
    expect(supportsReasoningEffort(ChatModels.CLAUDE_5_OPUS)).toBe(true);
    expect(supportsReasoningEffort(ChatModels.CLAUDE_4_5_SONNET)).toBe(false);
    expect(supportsReasoningEffort('something-this-server-invented')).toBe(false);
  });
});
