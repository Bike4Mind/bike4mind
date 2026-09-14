import { ChatModels, NO_TEMPERATURE_MODELS } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_MAX_STOP_SEQUENCES,
  DEEPSEEK_MODELS,
  DEEPSEEK_THINKING_TOP_P_FLOOR,
  deepseekReasoningParams,
  deepseekSamplingParams,
  deepseekStopSequences,
  toDeepSeekEffort,
} from './deepseekParams';
import { DeepSeekBackend } from './deepseekBackend';

/**
 * Every assertion here maps to a documented per-model constraint. Unlike Kimi,
 * getting one wrong on DeepSeek is usually SILENT - the parameter is accepted and
 * ignored - which is why the shaping lives in pure functions with this file next
 * to them rather than being inferred from a live 400.
 * @see https://api-docs.deepseek.com/guides/thinking_mode
 */
describe('toDeepSeekEffort', () => {
  it("maps B4M's six levels onto DeepSeek's three", () => {
    expect(toDeepSeekEffort('none')).toBe('low');
    expect(toDeepSeekEffort('minimal')).toBe('low');
    expect(toDeepSeekEffort('low')).toBe('low');
    expect(toDeepSeekEffort('medium')).toBe('high');
    expect(toDeepSeekEffort('high')).toBe('high');
    expect(toDeepSeekEffort('xhigh')).toBe('max');
  });

  it('is undefined when no effort was requested', () => {
    expect(toDeepSeekEffort(undefined)).toBeUndefined();
  });
});

describe('deepseekReasoningParams', () => {
  it('sends reasoning_effort on the shipped id', () => {
    expect(deepseekReasoningParams(ChatModels.DEEPSEEK_FLASH, { reasoningEffort: 'xhigh' })).toEqual({
      reasoning_effort: 'max',
    });
  });

  it('omits both spellings when nothing was asked for, leaving DeepSeek its default', () => {
    // Thinking is enabled at effort 'high' when neither parameter is present.
    // Substituting a level unasked would quietly change answer quality.
    expect(deepseekReasoningParams(ChatModels.DEEPSEEK_FLASH, {})).toEqual({});
  });

  it('sends the thinking toggle and the effort together, which DeepSeek allows', () => {
    // The two are independent here, unlike Kimi where sending both is a 400.
    expect(
      deepseekReasoningParams(ChatModels.DEEPSEEK_FLASH, { thinking: { enabled: true }, reasoningEffort: 'low' })
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  });

  it('drops the effort when the caller turned thinking off', () => {
    // There is no 'none' effort level, so an effort alongside a disable would
    // state two contradictory things about the same turn.
    expect(
      deepseekReasoningParams(ChatModels.DEEPSEEK_FLASH, { thinking: { enabled: false }, reasoningEffort: 'high' })
    ).toEqual({ thinking: { type: 'disabled' } });
  });

  it('sends nothing for a model outside the DeepSeek family', () => {
    // The Bedrock-served and Ollama DeepSeek ids take none of this.
    expect(deepseekReasoningParams(ChatModels.DEEPSEEK_R1, { reasoningEffort: 'high' })).toEqual({});
    expect(deepseekReasoningParams(ChatModels.DEEPSEEK_V3_1, { thinking: { enabled: true } })).toEqual({});
  });
});

describe('deepseekSamplingParams', () => {
  /**
   * Thinking mode is the default, and DeepSeek documents temperature,
   * presence_penalty and frequency_penalty as unsupported there. They are
   * ignored rather than rejected, so nothing surfaces the mistake - the answer
   * is simply not the one the knob asked for.
   */
  it('drops the whole ignored sampling group while thinking is on', () => {
    expect(
      deepseekSamplingParams(ChatModels.DEEPSEEK_FLASH, {
        temperature: 0.7,
        presencePenalty: 0.2,
        frequencyPenalty: 0.3,
      })
    ).toEqual({});
  });

  it('hands the group back once the caller turns thinking off', () => {
    // The restriction belongs to thinking mode, not to the id. Dropping
    // temperature on a thinking-disabled turn reproduces from our side the exact
    // silent no-op the drop exists to prevent: the knob moves, nothing happens.
    expect(
      deepseekSamplingParams(
        ChatModels.DEEPSEEK_FLASH,
        { temperature: 0.2, topP: 0.3, presencePenalty: 0.2, frequencyPenalty: 0.3 },
        { thinking: { enabled: false } }
      )
    ).toEqual({ temperature: 0.2, top_p: 0.3, presence_penalty: 0.2, frequency_penalty: 0.3 });
  });

  it('keeps dropping the group when thinking is explicitly enabled', () => {
    expect(
      deepseekSamplingParams(ChatModels.DEEPSEEK_FLASH, { temperature: 0.2 }, { thinking: { enabled: true } })
    ).toEqual({});
  });

  it('leaves top_p unclamped once thinking is off, the floor being a thinking-mode rule', () => {
    expect(deepseekSamplingParams(ChatModels.DEEPSEEK_FLASH, { topP: 0.3 }, { thinking: { enabled: false } })).toEqual({
      top_p: 0.3,
    });
  });

  it('clamps top_p up to the documented floor rather than dropping it', () => {
    // DeepSeek raises anything below 0.95 itself, so sending the clamped value
    // makes the request state what the server will actually apply.
    expect(deepseekSamplingParams(ChatModels.DEEPSEEK_FLASH, { topP: 0.3 })).toEqual({
      top_p: DEEPSEEK_THINKING_TOP_P_FLOOR,
    });
  });

  it('leaves a top_p above the floor alone', () => {
    expect(deepseekSamplingParams(ChatModels.DEEPSEEK_FLASH, { topP: 0.99 })).toEqual({ top_p: 0.99 });
  });

  it('sends nothing it was not given', () => {
    expect(deepseekSamplingParams(ChatModels.DEEPSEEK_FLASH, {})).toEqual({});
  });

  it('passes the group through for a model outside the DeepSeek family', () => {
    expect(
      deepseekSamplingParams('deepseek-chat-hypothetical', {
        temperature: 0.7,
        topP: 0.5,
        presencePenalty: 0.2,
        frequencyPenalty: 0.3,
      })
    ).toEqual({ temperature: 0.7, top_p: 0.5, presence_penalty: 0.2, frequency_penalty: 0.3 });
  });
});

/**
 * Both shapers gate on DEEPSEEK_MODELS, and the picker hides the sampling knobs
 * on the strength of NO_TEMPERATURE_MODELS. Three lists that have to name the
 * same ids, none of which imports the others.
 */
describe('DEEPSEEK_MODELS agreement', () => {
  // getModelInfo() returns a static array, so this key is never used for a network call.
  const shippedIds = async () =>
    (await new DeepSeekBackend('test-key-not-used').getModelInfo()).map(model => String(model.id));

  it('names exactly the ids the adapter table ships', async () => {
    expect([...DEEPSEEK_MODELS].sort()).toEqual((await shippedIds()).sort());
  });

  it('agrees with NO_TEMPERATURE_MODELS, which is what hides the knobs in the picker', () => {
    const missing = [...DEEPSEEK_MODELS].filter(model => !NO_TEMPERATURE_MODELS.has(model));
    expect(missing, `DeepSeek ids the picker still offers temperature for: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('deepseekStopSequences', () => {
  it('truncates to the 16 sequences DeepSeek accepts', () => {
    const stop = Array.from({ length: 20 }, (_, i) => `s${i}`);
    expect(deepseekStopSequences(stop)).toHaveLength(DEEPSEEK_MAX_STOP_SEQUENCES);
    expect(deepseekStopSequences(stop)?.[15]).toBe('s15');
  });

  it('leaves a within-limit array, a bare string and an absent value alone', () => {
    expect(deepseekStopSequences(['a', 'b'])).toEqual(['a', 'b']);
    expect(deepseekStopSequences('END')).toBe('END');
    expect(deepseekStopSequences(undefined)).toBeUndefined();
  });
});
