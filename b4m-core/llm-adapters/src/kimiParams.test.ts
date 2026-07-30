import { ChatModels } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { kimiReasoningParams, kimiSamplingParams, kimiToolChoice, toKimiEffort } from './kimiParams';

/**
 * Every assertion here maps to a documented per-model constraint. Getting one
 * wrong is a 400 on a live turn, not a subtle degradation, which is why the
 * shaping lives in pure functions with this file next to them.
 * @see https://platform.kimi.ai/docs/api/models-overview
 */
describe('toKimiEffort', () => {
  it("maps B4M's six levels onto Kimi's three", () => {
    expect(toKimiEffort('none')).toBe('low');
    expect(toKimiEffort('minimal')).toBe('low');
    expect(toKimiEffort('low')).toBe('low');
    expect(toKimiEffort('medium')).toBe('high');
    expect(toKimiEffort('high')).toBe('high');
    expect(toKimiEffort('xhigh')).toBe('max');
  });

  it('is undefined when no effort was requested', () => {
    expect(toKimiEffort(undefined)).toBeUndefined();
  });
});

describe('kimiReasoningParams', () => {
  it('sends reasoning_effort for K3 and never the thinking object', () => {
    const params = kimiReasoningParams(ChatModels.KIMI_K3, { reasoningEffort: 'high' });
    expect(params).toEqual({ reasoning_effort: 'high' });
  });

  it('omits reasoning_effort entirely when none was asked for, leaving Moonshot its default', () => {
    // Moonshot defaults K3 to 'max'. Substituting a cheaper level unasked would
    // quietly change answer quality, so the parameter is simply absent.
    expect(kimiReasoningParams(ChatModels.KIMI_K3, {})).toEqual({});
  });

  it('ignores a thinking toggle on K3, which cannot be told not to think', () => {
    expect(kimiReasoningParams(ChatModels.KIMI_K3, { thinking: { enabled: false } })).toEqual({});
  });

  it('sends thinking enabled/disabled for K2.6 and K2.5', () => {
    for (const model of [ChatModels.KIMI_K2_6, ChatModels.KIMI_K2_5]) {
      expect(kimiReasoningParams(model, { thinking: { enabled: true } })).toEqual({ thinking: { type: 'enabled' } });
      expect(kimiReasoningParams(model, { thinking: { enabled: false } })).toEqual({ thinking: { type: 'disabled' } });
    }
  });

  it('never sends reasoning_effort to a thinking-object model', () => {
    // Sending both spellings, or the wrong one, is a 400.
    const params = kimiReasoningParams(ChatModels.KIMI_K2_6, { reasoningEffort: 'high' });
    expect(params).not.toHaveProperty('reasoning_effort');
  });

  it('forces thinking on for the K2.7 code models even when the caller asked for none', () => {
    // `thinking.type: 'disabled'` is rejected upstream on these two, so honoring
    // the request literally would fail the turn.
    for (const model of [ChatModels.KIMI_K2_7_CODE, ChatModels.KIMI_K2_7_CODE_HIGHSPEED]) {
      expect(kimiReasoningParams(model, { thinking: { enabled: false } })).toEqual({ thinking: { type: 'enabled' } });
      expect(kimiReasoningParams(model, {})).toEqual({ thinking: { type: 'enabled' } });
    }
  });

  it('sends nothing for a model outside the Kimi family', () => {
    expect(kimiReasoningParams('gpt-5', { reasoningEffort: 'high' })).toEqual({});
  });
});

describe('kimiSamplingParams', () => {
  /**
   * Every current Kimi pins the sampling group. Moonshot's chat reference says
   * only the moonshot-v1 family accepts temperature/top_p, and the thinking guide
   * names k2.6 and k2.7-code explicitly as not modifiable. k2.6 was briefly
   * treated as an exception here on the strength of models.dev reporting
   * `temperature: true`; the primary docs win.
   */
  it('omits the whole sampling group on every shipped Kimi id', () => {
    for (const model of [
      ChatModels.KIMI_K3,
      ChatModels.KIMI_K2_7_CODE,
      ChatModels.KIMI_K2_7_CODE_HIGHSPEED,
      ChatModels.KIMI_K2_6,
      ChatModels.KIMI_K2_5,
    ]) {
      expect(
        kimiSamplingParams(model, {
          temperature: 0.7,
          topP: 0.5,
          presencePenalty: 0.2,
          frequencyPenalty: 0.3,
          n: 2,
        })
      ).toEqual({});
    }
  });

  it('passes the group through for a model outside the pinned set', () => {
    expect(
      kimiSamplingParams('moonshot-v1-8k', {
        temperature: 0.7,
        topP: 0.5,
        presencePenalty: 0.2,
        frequencyPenalty: 0.3,
        n: 2,
      })
    ).toEqual({ temperature: 0.7, top_p: 0.5, presence_penalty: 0.2, frequency_penalty: 0.3, n: 2 });
  });

  it('sends nothing it was not given', () => {
    expect(kimiSamplingParams('moonshot-v1-8k', {})).toEqual({});
  });
});

describe('kimiToolChoice', () => {
  it("downgrades 'required' to 'auto' on the ids that reject it", () => {
    for (const model of [ChatModels.KIMI_K2_7_CODE, ChatModels.KIMI_K2_7_CODE_HIGHSPEED, ChatModels.KIMI_K2_6]) {
      expect(kimiToolChoice(model, 'required')).toBe('auto');
    }
  });

  it("keeps 'required' on K3, which supports it", () => {
    expect(kimiToolChoice(ChatModels.KIMI_K3, 'required')).toBe('required');
  });

  it('passes auto, none and the explicit function form through untouched', () => {
    const explicit = { type: 'function' as const, function: { name: 'search' } };
    expect(kimiToolChoice(ChatModels.KIMI_K2_6, 'auto')).toBe('auto');
    expect(kimiToolChoice(ChatModels.KIMI_K2_6, 'none')).toBe('none');
    expect(kimiToolChoice(ChatModels.KIMI_K2_6, explicit)).toBe(explicit);
  });

  it('stays undefined when the caller set no choice', () => {
    expect(kimiToolChoice(ChatModels.KIMI_K3, undefined)).toBeUndefined();
  });
});
