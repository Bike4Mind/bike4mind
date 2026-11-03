import { ChatModels } from '@bike4mind/common';
import type { ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import {
  parseReasoningEffortSetting,
  reasoningEffortFor,
  requestsThinking,
  storedReasoningEffortSetting,
  supportsReasoningEffort,
} from './reasoningEffort';

describe('parseReasoningEffortSetting', () => {
  it('accepts each documented value, ignoring case and padding', () => {
    expect(parseReasoningEffortSetting(' Minimal ')).toBe('minimal');
    expect(parseReasoningEffortSetting('low')).toBe('low');
    expect(parseReasoningEffortSetting('medium')).toBe('medium');
    expect(parseReasoningEffortSetting('HIGH')).toBe('high');
    expect(parseReasoningEffortSetting('none')).toBe('none');
    expect(parseReasoningEffortSetting('xhigh')).toBe('xhigh');
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

  it('sends only a level the model lists once its controls are known', () => {
    const option: Pick<ChatModelOption, 'controls'> = {
      controls: { effort: { levels: ['none', 'low', 'xhigh'], scope: 'request' } },
    };
    expect(reasoningEffortFor('none', ChatModels.GPT5, option)).toBe('none');
    expect(reasoningEffortFor('xhigh', ChatModels.GPT5, option)).toBe('xhigh');
    expect(reasoningEffortFor('default', ChatModels.GPT5, option)).toBeUndefined();
    expect(reasoningEffortFor('high', ChatModels.GPT5, { controls: {} })).toBeUndefined();
  });

  it('sends the nearest listed level for a stored one the model no longer lists', () => {
    const listed = (...levels: ReasoningEffortSetting[]): Pick<ChatModelOption, 'controls'> => ({
      controls: { effort: { levels, scope: 'request' } },
    });
    expect(reasoningEffortFor('minimal', ChatModels.GPT5, listed('low', 'medium', 'high'))).toBe('low');
    expect(reasoningEffortFor('xhigh', ChatModels.GPT5, listed('low', 'medium', 'high'))).toBe('high');
    expect(reasoningEffortFor('medium', ChatModels.GPT5, listed('low', 'high'))).toBe('low');
    expect(reasoningEffortFor('minimal', ChatModels.GPT5, listed('none', 'low', 'xhigh'))).toBe('low');
    expect(reasoningEffortFor('none', ChatModels.GPT5, listed('low', 'high'))).toBe('low');
    expect(reasoningEffortFor('low', ChatModels.GPT5, listed('none'))).toBeUndefined();
  });

  it('keeps none and xhigh off a model whose levels are unknown, at the nearest of the old four', () => {
    expect(reasoningEffortFor('none', ChatModels.GPT5)).toBe('minimal');
    expect(reasoningEffortFor('xhigh', ChatModels.GPT5)).toBe('high');
    expect(reasoningEffortFor('minimal', ChatModels.GPT5)).toBe('minimal');
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

describe('requestsThinking', () => {
  const local = { thinkingToggle: true };

  it('turns thinking off only for a local thinking model switched Off, as Off is stored now and was before', () => {
    expect(requestsThinking('none', local)).toBe(false);
    expect(requestsThinking('minimal', local)).toBe(false);
  });

  it('thinks on every other setting of that model, including none stored', () => {
    for (const setting of ['default', 'low', 'medium', 'high', 'xhigh', undefined] as const) {
      expect(requestsThinking(setting, local)).toBe(true);
    }
  });

  it('keeps an older Minimal thinking where it was an effort the server ignored', () => {
    const learned = { thinkingToggle: true, minimalThinks: true as const };
    expect(requestsThinking('minimal', learned)).toBe(true);
    expect(requestsThinking('none', learned)).toBe(false);
  });

  it('has no switch on a model that lists effort levels, which thinks at the nearest one', () => {
    const gptOss: Pick<ChatModelOption, 'thinkingToggle' | 'controls'> = {
      thinkingToggle: true,
      controls: { effort: { levels: ['low', 'high'], scope: 'request' } },
    };
    expect(requestsThinking('minimal', gptOss, 'low')).toBe(true);
    expect(requestsThinking('none', gptOss, 'low')).toBe(true);
  });

  it('thinks on a model without the switch, or one the catalog does not know', () => {
    expect(requestsThinking('minimal', {})).toBe(true);
    expect(requestsThinking('minimal', undefined)).toBe(true);
  });

  it('does not think at an effort of none', () => {
    expect(requestsThinking('none', {}, 'none')).toBe(false);
    expect(requestsThinking('low', {}, 'low')).toBe(true);
  });
});
