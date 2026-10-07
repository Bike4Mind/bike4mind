import { describe, it, expect } from 'vitest';
import {
  ADAPTIVE_THINKING_MAX_TOKENS_FLOOR,
  ANTHROPIC_EFFORT_LEVELS,
  buildThinkingParams,
  DEFAULT_ANTHROPIC_EFFORT,
  DEFAULT_QUEST_MASTER_ANTHROPIC_EFFORT,
  reasonsWithinOutputBudget,
  resolveAnthropicEffort,
  resolveOutputMaxTokens,
  supportsAnthropicEffort,
  toAnthropicEffort,
  type AnthropicEffort,
} from './thinkingParams';
import {
  ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS,
  ChatModels,
  ModelBackend,
  type ModelInfo,
  type ReasoningEffort,
} from '@bike4mind/common';

const baseModelInfo: ModelInfo = {
  id: ChatModels.CLAUDE_4_6_OPUS,
  type: 'text',
  name: 'Claude 4.6 Opus',
  backend: ModelBackend.Anthropic,
  contextWindow: 1_000_000,
  max_tokens: 128_000,
  can_think: true,
  pricing: { 1_000_000: { input: 5 / 1_000_000, output: 25 / 1_000_000 } },
  supportsImageVariation: false,
};

const legacyModel: ModelInfo = { ...baseModelInfo };

/** GPT-5.6 Sol: a hardcoded OpenAI reasoning model, so REASONING_SUPPORTED_MODELS knows it. */
const openAiReasoningModel: ModelInfo = {
  ...baseModelInfo,
  id: ChatModels.GPT5_6_SOL,
  name: 'GPT-5.6 Sol',
  backend: ModelBackend.OpenAI,
  thinkingStyle: undefined,
};

/** The same shape, but an id no hardcoded set lists - only the dispatch profile identifies it. */
const catalogOnlyReasoningModel: ModelInfo = {
  ...baseModelInfo,
  id: 'some-unlisted-reasoning-model' as ModelInfo['id'],
  name: 'Unlisted reasoning model',
  backend: ModelBackend.OpenAI,
  thinkingStyle: undefined,
  can_think: true,
  dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
};
const adaptiveModel: ModelInfo = {
  ...baseModelInfo,
  id: ChatModels.CLAUDE_4_7_OPUS,
  name: 'Claude 4.7 Opus',
  thinkingStyle: 'adaptive',
};

describe('buildThinkingParams', () => {
  describe('legacy models (thinkingStyle unset or "legacy")', () => {
    it('returns type "enabled" with budget_tokens', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect(result.thinkingConfig.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    it('does not include output_config', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect('output_config' in result.thinkingConfig).toBe(false);
    });

    it('inflates max_tokens to budget + 1000', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect(result.maxTokens).toBe(17000);
    });

    it('keeps caller max_tokens when already larger than budget + 1000', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 8000, 32000);
      expect(result.maxTokens).toBe(32000);
    });

    it('sets temperature to 1 for normal models', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096);
      expect(result.temperature).toBe(1);
    });
  });

  describe('adaptive models (thinkingStyle: "adaptive")', () => {
    it('returns type "adaptive" without budget_tokens', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect(result.thinkingConfig.thinking).toEqual({ type: 'adaptive' });
    });

    it('includes output_config with effort', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect((result.thinkingConfig as { output_config: { effort: string } }).output_config).toEqual({
        effort: 'high',
      });
    });

    it('uses custom effort level', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096, 'medium');
      expect((result.thinkingConfig as { output_config: { effort: string } }).output_config).toEqual({
        effort: 'medium',
      });
    });

    it('applies 64K max_tokens floor', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect(result.maxTokens).toBe(64_000);
    });

    it('keeps caller max_tokens when already above 64K floor', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 100000);
      expect(result.maxTokens).toBe(100000);
    });

    it('returns temperature "delete" for NO_TEMPERATURE_MODELS', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_4_7_OPUS, adaptiveModel, 16000, 4096);
      expect(result.temperature).toBe('delete');
    });
  });
});

describe('resolveOutputMaxTokens', () => {
  const resolve = (requested: number | undefined, modelInfo: ModelInfo) =>
    resolveOutputMaxTokens({
      requested,
      fallback: 4096,
      modelInfo,
      modelMaxOutputTokens: modelInfo.max_tokens,
    });

  describe('an explicit caller budget is never raised', () => {
    // The bug this guards: flooring adaptive models unconditionally silently
    // multiplied a caller's stated budget, which also inflates the credit
    // pre-reservation and shrinks the usable input window.
    it('honors a budget below the adaptive floor on an adaptive model', () => {
      expect(resolve(16_000, adaptiveModel)).toBe(16_000);
    });

    it('honors a tiny budget on an adaptive model', () => {
      expect(resolve(50, adaptiveModel)).toBe(50);
    });

    it('honors a budget on a legacy model', () => {
      expect(resolve(16_000, legacyModel)).toBe(16_000);
    });

    it('honors a budget on an OpenAI reasoning model', () => {
      expect(resolve(16_000, openAiReasoningModel)).toBe(16_000);
    });
  });

  describe('absence is sized for the model', () => {
    it('defaults an adaptive model to the shared floor', () => {
      expect(resolve(undefined, adaptiveModel)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    it('defaults a legacy model to the caller-supplied fallback', () => {
      expect(resolve(undefined, legacyModel)).toBe(4096);
    });

    // The starvation this fixes: OpenAI spends reasoning inside max_completion_tokens,
    // so a 4096 default was consumed entirely by reasoning and the turn came back empty.
    it('defaults an OpenAI reasoning model to the shared floor', () => {
      expect(resolve(undefined, openAiReasoningModel)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    // Catalog-only reasoning models are not in any hardcoded set, so the reasoning-shaped
    // max-tokens param plus can_think has to carry them.
    it('defaults an unlisted but reasoning-shaped catalog model to the shared floor', () => {
      expect(resolve(undefined, catalogOnlyReasoningModel)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    // can_think alone must not trigger headroom: legacy thinking is opt-in and
    // separately budgeted, so these models would pay for room they never use.
    it('does not give a non-reasoning-shaped model the floor merely for can_think', () => {
      expect(resolve(undefined, { ...legacyModel, can_think: true })).toBe(4096);
    });
  });

  describe('clamps to the model output cap', () => {
    it('clamps an over-large explicit budget', () => {
      expect(resolve(500_000, legacyModel)).toBe(128_000);
    });

    // Over-requesting 400s the whole turn, so the adaptive default must yield to a
    // model whose own cap is smaller than the floor.
    it('clamps the adaptive default on a model capped below the floor', () => {
      const smallCap: ModelInfo = { ...adaptiveModel, max_tokens: 8192 };
      expect(resolve(undefined, smallCap)).toBe(8192);
    });
  });

  /**
   * A cap toModelInfo DERIVED (the 4096 default for a row that declares none) is not the
   * model's real ceiling. Clamping to it produces min(64000, 4096) for a model that reasons
   * inside its output budget - the same starvation the floor above exists to prevent, arrived
   * at from a default rather than from data.
   */
  describe('a derived cap does not clamp a model that reasons inside its budget', () => {
    const derived = (info: ModelInfo, max_tokens = 4096): ModelInfo => ({
      ...info,
      max_tokens,
      maxOutputTokensDerived: true,
    });

    it('keeps the adaptive floor', () => {
      expect(resolve(undefined, derived(adaptiveModel))).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    it('keeps the floor for a catalog-only reasoning-shaped model', () => {
      expect(resolve(undefined, derived(catalogOnlyReasoningModel))).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    it('honors an explicit budget above the derived cap', () => {
      expect(resolve(32_000, derived(adaptiveModel))).toBe(32_000);
    });

    // Still a clamp, just a defensible one: an over-request would 400 the turn, and the value
    // also sizes the credit pre-reservation.
    it('clamps an over-large explicit budget to the stand-in ceiling', () => {
      expect(resolve(500_000, derived(adaptiveModel))).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    // contextWindow is the input+output budget, so the stand-in ceiling may claim at most half
    // of what is left after the safety buffer - otherwise the prompt has nowhere to go.
    it('leaves the prompt room on a window too small to fund the floor', () => {
      expect(resolve(undefined, derived({ ...adaptiveModel, contextWindow: 60_000 }))).toBe(29_500);
    });

    // Never shrinks: on a window too small even for that share, the derived cap still stands.
    it('never resolves below the derived cap itself', () => {
      expect(resolve(undefined, derived({ ...adaptiveModel, contextWindow: 8_000 }))).toBe(4096);
    });

    // Nothing changes for a model that does not reason inside its budget: 4096 was never a
    // starving default there, and the derived value is the most conservative thing known.
    it('still clamps a non-reasoning model', () => {
      expect(resolve(500_000, derived(legacyModel))).toBe(4096);
    });

    // A declared cap is data about the model and keeps clamping, adaptive or not.
    it('still clamps an adaptive model to a declared cap', () => {
      expect(resolve(undefined, { ...adaptiveModel, max_tokens: 8192 })).toBe(8192);
    });
  });

  /**
   * The resolver has to be total. It sizes a credit reservation two call sites downstream,
   * and `Math.min(n, undefined)` is NaN - which reached a Mongoose `currentCredits` write as
   * an opaque mid-stream cast error, and slipped past the org per-member cap on the way
   * (`used + NaN > cap` is false). `ModelInfo.max_tokens` is typed `number`, but that is a
   * claim about catalog data: a row built anywhere other than toModelInfo can omit it.
   */
  describe('an unusable model cap does not poison the budget', () => {
    const capped = (max_tokens: unknown): ModelInfo => ({ ...legacyModel, max_tokens }) as ModelInfo;

    it('falls back to the fallback when a non-reasoning row declares no cap', () => {
      expect(resolve(undefined, capped(undefined))).toBe(4096);
    });

    it('keeps the adaptive floor rather than re-pinning to 4096 when the cap is absent', () => {
      expect(resolve(undefined, { ...adaptiveModel, max_tokens: undefined } as ModelInfo)).toBe(
        ADAPTIVE_THINKING_MAX_TOKENS_FLOOR
      );
    });

    // An unknown cap must not silently shrink a deliberate choice - that is the same class of
    // bug as the starvation above, just aimed at the caller instead of the model.
    it('honors an explicit budget when the cap is absent', () => {
      expect(resolve(32_000, capped(undefined))).toBe(32_000);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['zero', 0],
      ['negative', -1],
    ])('treats a %s cap as unknown rather than clamping to it', (_label, value) => {
      expect(resolve(undefined, capped(value))).toBe(4096);
    });

    it('never returns a non-finite budget for any of those rows', () => {
      for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
        expect(Number.isFinite(resolve(undefined, capped(value)))).toBe(true);
        expect(Number.isFinite(resolve(8192, capped(value)))).toBe(true);
      }
    });

    // A caller can hand us junk too, and it lands on the same money path.
    it('treats a non-finite requested budget as no preference', () => {
      expect(resolve(Number.NaN, legacyModel)).toBe(4096);
      expect(resolve(Number.NaN, adaptiveModel)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });
  });

  // Bedrock's Kimi ids reason inside max_tokens but match none of the shape checks:
  // no adaptive thinkingStyle, no reasoning_effort, plain max_tokens. Left on the
  // 4096 fallback, k2-thinking spent the whole budget on its monologue and the reply
  // reached the user as a reasoning trace cut off at </think>.
  describe('models that reason inside the output budget by id', () => {
    const kimiThinking: ModelInfo = {
      ...baseModelInfo,
      id: ChatModels.KIMI_K2_THINKING_BEDROCK,
      name: 'Kimi K2 Thinking (Bedrock)',
      backend: ModelBackend.Bedrock,
      max_tokens: 16_384,
    };
    const kimiK25: ModelInfo = { ...kimiThinking, id: ChatModels.KIMI_K2_5_BEDROCK, name: 'Kimi K2.5 (Bedrock)' };

    it('defaults k2-thinking to its own cap rather than the fallback', () => {
      expect(resolve(undefined, kimiThinking)).toBe(16_384);
    });

    it('defaults k2.5 to its own cap rather than the fallback', () => {
      expect(resolve(undefined, kimiK25)).toBe(16_384);
    });

    it('still honors an explicit caller budget', () => {
      expect(resolve(2048, kimiThinking)).toBe(2048);
    });

    it('leaves a non-listed model on the fallback', () => {
      expect(resolve(undefined, legacyModel)).toBe(4096);
    });

    it('reports the Kimi ids as reasoning within the output budget', () => {
      expect(reasonsWithinOutputBudget(kimiThinking)).toBe(true);
      expect(reasonsWithinOutputBudget(kimiK25)).toBe(true);
      expect(reasonsWithinOutputBudget(legacyModel)).toBe(false);
    });

    // DeepSeek Flash misses every shape check for a different reason than Kimi: the
    // dispatch profile says `max_tokens` (which is what DeepSeek takes) rather than
    // `max_completion_tokens`, so the catalog-only clause cannot see it either. Left on
    // the 4096 fallback it reasons at effort 'high' inside that budget, returns
    // finish_reason 'length' with no content, and deepseekBackend throws.
    const deepseekFlash: ModelInfo = {
      ...baseModelInfo,
      id: ChatModels.DEEPSEEK_FLASH,
      name: 'DeepSeek Flash',
      backend: ModelBackend.DeepSeek,
      can_think: true,
      max_tokens: 393_216,
      dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'chat' },
    };

    it('reports DeepSeek Flash as reasoning within the output budget', () => {
      expect(reasonsWithinOutputBudget(deepseekFlash)).toBe(true);
    });

    it('defaults DeepSeek Flash to the reasoning floor, not the 4096 fallback', () => {
      // Its own cap is far above the floor, so the floor is what applies.
      expect(resolve(undefined, deepseekFlash)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    it('still honors an explicit budget on DeepSeek Flash', () => {
      expect(resolve(8192, deepseekFlash)).toBe(8192);
    });

    const deepseekV4Pro: ModelInfo = {
      ...baseModelInfo,
      id: ChatModels.DEEPSEEK_V4_PRO,
      name: 'DeepSeek V4 Pro',
      backend: ModelBackend.DeepSeek,
      can_think: true,
      max_tokens: 393_216,
      dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'chat' },
    };

    it('reports DeepSeek V4 Pro as reasoning within the output budget', () => {
      expect(reasonsWithinOutputBudget(deepseekV4Pro)).toBe(true);
    });

    it('defaults DeepSeek V4 Pro to the reasoning floor, not the 4096 fallback', () => {
      expect(resolve(undefined, deepseekV4Pro)).toBe(ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);
    });

    it('still honors an explicit budget on DeepSeek V4 Pro', () => {
      expect(resolve(8192, deepseekV4Pro)).toBe(8192);
    });

    // Bedrock DeepSeek R1 also inlines its monologue into the output budget
    // (bedrockBackend/deepseek.ts) and matches no shape check either: no
    // thinkingStyle, absent from REASONING_SUPPORTED_MODELS, and its profile
    // declares plain max_tokens. Its cap is 32K, so the floor resolves to that cap -
    // the value that actually leaves room for an answer after a long trace.
    const deepseekR1Bedrock: ModelInfo = {
      ...baseModelInfo,
      id: ChatModels.DEEPSEEK_R1_BEDROCK,
      name: 'DeepSeek R1',
      backend: ModelBackend.Bedrock,
      max_tokens: 32_768,
      can_stream: true,
      supportsVision: false,
    };

    it('reports Bedrock DeepSeek R1 as reasoning within the output budget', () => {
      expect(reasonsWithinOutputBudget(deepseekR1Bedrock)).toBe(true);
    });

    it('defaults Bedrock DeepSeek R1 to its own cap rather than the 4096 fallback', () => {
      expect(resolve(undefined, deepseekR1Bedrock)).toBe(32_768);
    });

    it('still honors an explicit budget on Bedrock DeepSeek R1', () => {
      expect(resolve(8192, deepseekR1Bedrock)).toBe(8192);
    });
  });
});

const effortOf = (result: ReturnType<typeof buildThinkingParams>): AnthropicEffort | undefined =>
  (result.thinkingConfig as { output_config?: { effort: AnthropicEffort } }).output_config?.effort;

describe('Anthropic effort levels', () => {
  it('offers exactly the five levels the current Claude models accept', () => {
    expect(ANTHROPIC_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it.each(ANTHROPIC_EFFORT_LEVELS)('sends %s through to output_config', level => {
    const result = buildThinkingParams(ChatModels.CLAUDE_5_OPUS, adaptiveModel, 16000, 4096, level);
    expect(effortOf(result)).toBe(level);
  });

  // A legacy model has no output_config at all, so no level can reach it.
  it.each(ANTHROPIC_EFFORT_LEVELS)('never emits output_config on a legacy model for %s', level => {
    const result = buildThinkingParams(ChatModels.CLAUDE_4_6_OPUS, legacyModel, 16000, 4096, level);
    expect('output_config' in result.thinkingConfig).toBe(false);
  });
});

describe('supportsAnthropicEffort', () => {
  it.each(Array.from(ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS))('accepts %s from the capability set', id => {
    expect(supportsAnthropicEffort(id, undefined)).toBe(true);
  });

  // The record is the fallback for a model only the catalog knows about.
  it('accepts a catalog-only model whose record says adaptive', () => {
    expect(supportsAnthropicEffort('claude-opus-9-unreleased', adaptiveModel)).toBe(true);
  });

  it('rejects a legacy Claude model', () => {
    expect(supportsAnthropicEffort(ChatModels.CLAUDE_4_6_OPUS, legacyModel)).toBe(false);
  });

  it('rejects an OpenAI reasoning model, whose effort is a different wire field', () => {
    expect(supportsAnthropicEffort(ChatModels.GPT5_6_SOL, openAiReasoningModel)).toBe(false);
  });

  // A set member must get the effort shape even when its catalog row is sparse, which
  // is the whole reason the set is consulted ahead of the record.
  it('builds the adaptive shape for a set member whose record omits thinkingStyle', () => {
    const sparse: ModelInfo = { ...baseModelInfo, id: ChatModels.CLAUDE_5_OPUS, thinkingStyle: undefined };
    const result = buildThinkingParams(ChatModels.CLAUDE_5_OPUS, sparse, 16000, 4096, 'xhigh');
    expect(result.thinkingConfig.thinking).toEqual({ type: 'adaptive' });
    expect(effortOf(result)).toBe('xhigh');
  });
});

describe('toAnthropicEffort', () => {
  // The four shared names mean the same depth on both sides, so they pass through.
  // Promoting 'xhigh' to 'max' (what Kimi and DeepSeek do) would buy more reasoning
  // than was asked for, because unlike those providers Anthropic has both levels.
  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
  ] as const)('passes %s through unchanged', (input, expected) => {
    expect(toAnthropicEffort(input)).toBe(expected);
  });

  // Omitting instead would leave the turn on the 'high' default - MORE reasoning than
  // a least-effort request asked for, not less.
  it.each(['none', 'minimal'] as const)('resolves %s to the least level Anthropic can express', input => {
    expect(toAnthropicEffort(input)).toBe('low');
  });

  it('maps an unstated effort to undefined so the default survives', () => {
    expect(toAnthropicEffort(undefined)).toBeUndefined();
  });

  // The guarantee the mapping exists for: nothing outside Anthropic's vocabulary
  // can reach output_config.effort.
  it('only ever produces a level Anthropic accepts', () => {
    const everyValue: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    for (const value of everyValue) {
      const mapped = toAnthropicEffort(value);
      expect(mapped).toBeDefined();
      expect(ANTHROPIC_EFFORT_LEVELS).toContain(mapped);
    }
  });
});

describe('resolveAnthropicEffort', () => {
  describe('an unstated effort behaves exactly as before effort was wired', () => {
    it('is high for an ordinary turn', () => {
      expect(resolveAnthropicEffort({})).toBe('high');
      expect(resolveAnthropicEffort({})).toBe(DEFAULT_ANTHROPIC_EFFORT);
    });

    it('is medium for a QuestMaster turn', () => {
      expect(resolveAnthropicEffort({ questMaster: true })).toBe('medium');
      expect(resolveAnthropicEffort({ questMaster: true })).toBe(DEFAULT_QUEST_MASTER_ANTHROPIC_EFFORT);
    });

    it('is unchanged when both effort options are explicitly undefined', () => {
      expect(resolveAnthropicEffort({ anthropicEffort: undefined, reasoningEffort: undefined })).toBe('high');
      expect(
        resolveAnthropicEffort({ questMaster: true, anthropicEffort: undefined, reasoningEffort: undefined })
      ).toBe('medium');
    });

    // buildThinkingParams defaults to the same value, so a caller that passes no
    // effort argument at all is on the old behavior too.
    it('matches what buildThinkingParams sends with no effort argument', () => {
      const result = buildThinkingParams(ChatModels.CLAUDE_5_OPUS, adaptiveModel, 16000, 4096);
      expect(effortOf(result)).toBe(resolveAnthropicEffort({}));
    });
  });

  describe('a stated effort wins', () => {
    it.each(ANTHROPIC_EFFORT_LEVELS)('takes the native option %s over the default', level => {
      expect(resolveAnthropicEffort({ anthropicEffort: level })).toBe(level);
    });

    it('takes the native option over a QuestMaster default', () => {
      expect(resolveAnthropicEffort({ questMaster: true, anthropicEffort: 'max' })).toBe('max');
    });

    it('maps reasoningEffort when the native option is unset', () => {
      expect(resolveAnthropicEffort({ reasoningEffort: 'xhigh' })).toBe('xhigh');
      expect(resolveAnthropicEffort({ reasoningEffort: 'none' })).toBe('low');
    });

    // The native option is in Anthropic's own vocabulary, so it is the more specific
    // statement of the two and the only route to 'max'.
    it('prefers the native option to a conflicting reasoningEffort', () => {
      expect(resolveAnthropicEffort({ anthropicEffort: 'max', reasoningEffort: 'low' })).toBe('max');
    });

    it('overrides the QuestMaster default from reasoningEffort', () => {
      expect(resolveAnthropicEffort({ questMaster: true, reasoningEffort: 'xhigh' })).toBe('xhigh');
    });
  });
});
