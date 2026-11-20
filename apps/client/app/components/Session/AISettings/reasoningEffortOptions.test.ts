import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { reasoningEffortOptionsFor } from './reasoningEffortOptions';

function info(id: string, backend: ModelBackend, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: id as ModelInfo['id'],
    type: 'text',
    name: id,
    backend,
    contextWindow: 200_000,
    max_tokens: 64_000,
    pricing: {},
    supportsImageVariation: false,
    ...extra,
  };
}

const ADAPTIVE = { can_think: true, thinkingStyle: 'adaptive' as const };
const values = (model: string, modelInfo: ModelInfo | null | undefined) =>
  reasoningEffortOptionsFor(model, modelInfo).map(o => o.value);

describe('reasoningEffortOptionsFor', () => {
  it('keeps the fixed OpenAI list, with or without model info', () => {
    expect(reasoningEffortOptionsFor(ChatModels.GPT5, null)).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'low', label: 'Low (Fast)' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High (Best)' },
    ]);
  });

  it('adds Extra High on GPT-5.2 and relabels High', () => {
    const options = reasoningEffortOptionsFor(ChatModels.GPT5_2, null);
    expect(options.map(o => o.value)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh']);
    expect(options.find(o => o.value === 'high')?.label).toBe('High');
  });

  it('lists the levels an adaptive Claude model takes, with None only where thinking can be turned off', () => {
    const opus = info(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Anthropic, ADAPTIVE);
    expect(values(ChatModels.CLAUDE_5_5_OPUS, opus)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh']);
    const haiku = info(ChatModels.CLAUDE_5_5_HAIKU, ModelBackend.Anthropic, ADAPTIVE);
    expect(reasoningEffortOptionsFor(ChatModels.CLAUDE_5_5_HAIKU, haiku)).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'none', label: 'None' },
      { value: 'low', label: 'Low (Fast)' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High (Best)' },
    ]);
  });

  it('hides the dropdown on a legacy or non-thinking Claude model', () => {
    const legacy = info(ChatModels.CLAUDE_4_5_HAIKU, ModelBackend.Anthropic, { can_think: true });
    expect(values(ChatModels.CLAUDE_4_5_HAIKU, legacy)).toEqual([]);
    expect(values(ChatModels.CLAUDE_4_5_HAIKU, info(ChatModels.CLAUDE_4_5_HAIKU, ModelBackend.Anthropic))).toEqual([]);
  });

  it('hides it without model info, or with info for another model', () => {
    const opus = info(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Anthropic, ADAPTIVE);
    expect(values(ChatModels.CLAUDE_5_5_OPUS, null)).toEqual([]);
    expect(values(ChatModels.CLAUDE_5_5_OPUS, undefined)).toEqual([]);
    expect(values(ChatModels.CLAUDE_5_5_HAIKU, opus)).toEqual([]);
  });

  it('hides it on a non-Claude, non-OpenAI-reasoning model, as before', () => {
    const gemini = info(ChatModels.GEMINI_3_1_PRO_PREVIEW, ModelBackend.Gemini, { can_think: true });
    expect(values(ChatModels.GEMINI_3_1_PRO_PREVIEW, gemini)).toEqual([]);
  });
});
