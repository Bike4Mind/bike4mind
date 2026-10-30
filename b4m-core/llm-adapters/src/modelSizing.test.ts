import { describe, expect, it } from 'vitest';
import { ADAPTIVE_THINKING_MAX_TOKENS_FLOOR, ChatModels, type ModelInfo } from '@bike4mind/common';
import { sentBelowReasoningFloor, sentMaxTokensFor } from './modelSizing';

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

describe('sentBelowReasoningFloor', () => {
  const adaptiveModel = { ...legacyModel, thinkingStyle: 'adaptive', max_tokens: 128_000 } as ModelInfo;
  const args = (model: ModelInfo, thinking: { enabled?: boolean; budget_tokens?: number } | undefined) => ({
    requested: 8192,
    fallback: 4096,
    modelInfo: model,
    modelMaxOutputTokens: model.max_tokens,
    thinking,
  });

  it('reports a budget below the floor that is sent as set', () => {
    expect(sentBelowReasoningFloor(args(adaptiveModel, undefined))).toEqual({
      requested: 8192,
      floor: ADAPTIVE_THINKING_MAX_TOKENS_FLOOR,
    });
    expect(sentBelowReasoningFloor(args(adaptiveModel, { enabled: false }))).toBeDefined();
  });

  // buildThinkingParams sends at least the floor here, so the turn never runs below it.
  it('does not report a thinking turn the Anthropic adapter raises to the floor', () => {
    expect(sentBelowReasoningFloor(args(adaptiveModel, { enabled: true }))).toBeUndefined();
  });

  // Only the Anthropic adapters raise for thinking; elsewhere the budget is sent as set.
  it('still reports a thinking turn on an adapter that sends the budget as set', () => {
    const openaiReasoning = {
      ...adaptiveModel,
      id: ChatModels.GPT5_4_MINI,
      backend: 'openai',
      thinkingStyle: undefined,
      dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'responses' },
    } as ModelInfo;
    expect(sentBelowReasoningFloor(args(openaiReasoning, { enabled: true }))).toBeDefined();
  });

  it('does not report what belowReasoningFloor does not', () => {
    expect(sentBelowReasoningFloor({ ...args(adaptiveModel, undefined), requested: undefined })).toBeUndefined();
    expect(sentBelowReasoningFloor({ ...args(adaptiveModel, undefined), requested: 100_000 })).toBeUndefined();
  });
});
