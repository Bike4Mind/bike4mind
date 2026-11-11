import {
  ChatModels,
  isClaudeModelId,
  listModelsContract,
  ModelBackend,
  OPENAI_XHIGH_REASONING_EFFORT_MODELS,
  REASONING_SUPPORTED_MODELS,
  toPublicModel,
  type ModelInfo,
  type ReasoningEffort,
} from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { staticPriceBackends } from './adapterPriceLiterals';
import { AnthropicBackend } from './anthropicBackend';
import { DEEPSEEK_MODELS } from './deepseekParams';
import { KIMI_MODELS } from './kimiParams';
import {
  chatReasoningEffortFor,
  chatReasoningEffortsFor,
  clampReasoningEffort,
  reasoningEffortsFor,
} from './reasoningEfforts';
import { reasonsWithinOutputBudget } from './thinkingParams';

const ALL: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const ALL_BUT_NONE: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const OPENAI_LEVELS: ReasoningEffort[] = ['low', 'medium', 'high'];

function model(id: string, backend: ModelBackend, extra: Partial<ModelInfo> = {}): ModelInfo {
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

describe('reasoningEffortsFor', () => {
  it('advertises only the levels every OpenAI reasoning model accepts, since the value is forwarded verbatim', () => {
    for (const id of REASONING_SUPPORTED_MODELS) {
      expect(reasoningEffortsFor(model(id, ModelBackend.OpenAI, { can_think: true })), id).toEqual(OPENAI_LEVELS);
    }
  });

  it('advertises the OpenAI levels for a catalog-only model whose record says openai-effort', () => {
    expect(
      reasoningEffortsFor(model('gpt-6-sol', ModelBackend.OpenAI, { can_think: true, openaiReasoningEffort: true }))
    ).toEqual(OPENAI_LEVELS);
  });

  it('never infers OpenAI effort support from can_think alone', () => {
    expect(reasoningEffortsFor(model('gpt-6-sol', ModelBackend.OpenAI, { can_think: true }))).toEqual([]);
  });

  it('is empty on an OpenAI reasoning id served by another backend, which never sends the option', () => {
    expect(reasoningEffortsFor(model(ChatModels.O3, ModelBackend.Ollama, { can_think: true }))).toEqual([]);
  });

  it('is empty on an OpenAI model outside REASONING_SUPPORTED_MODELS, which never sends reasoning_effort', () => {
    expect(reasoningEffortsFor(model(ChatModels.GPT5_5, ModelBackend.OpenAI))).toEqual([]);
  });

  it('honours effort on Kimi K3 only, and never advertises none since K3 always reasons', () => {
    for (const id of KIMI_MODELS) {
      const expected = id === ChatModels.KIMI_K3 ? ALL_BUT_NONE : [];
      expect(reasoningEffortsFor(model(id, ModelBackend.Kimi, { can_think: true })), id).toEqual(expected);
    }
  });

  it('honours effort on every direct DeepSeek id, without none, which maps to low', () => {
    for (const id of DEEPSEEK_MODELS) {
      expect(reasoningEffortsFor(model(id, ModelBackend.DeepSeek, { can_think: true })), id).toEqual(ALL_BUT_NONE);
    }
  });

  it('is empty on the Bedrock-served Kimi and DeepSeek, which take no effort parameter', () => {
    for (const id of [ChatModels.KIMI_K2_THINKING_BEDROCK, ChatModels.DEEPSEEK_R1_BEDROCK]) {
      expect(reasoningEffortsFor(model(id, ModelBackend.Bedrock, { can_think: true })), id).toEqual([]);
    }
  });

  it('lists none on an adaptive Claude model only when it has an off switch', () => {
    const adaptive = { can_think: true, thinkingStyle: 'adaptive' as const };
    expect(reasoningEffortsFor(model(ChatModels.CLAUDE_5_SONNET, ModelBackend.Anthropic, adaptive))).toEqual(ALL);
    expect(reasoningEffortsFor(model(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Anthropic, adaptive))).toEqual(
      ALL_BUT_NONE
    );
    expect(reasoningEffortsFor(model(ChatModels.CLAUDE_5_5_OPUS_BEDROCK, ModelBackend.Bedrock, adaptive))).toEqual(
      ALL_BUT_NONE
    );
  });

  it('lists every level on a legacy thinking Claude model, whose default is already no thinking', () => {
    expect(
      reasoningEffortsFor(model(ChatModels.CLAUDE_4_5_HAIKU, ModelBackend.Anthropic, { can_think: true }))
    ).toEqual(ALL);
  });

  it('is empty on a Claude model that cannot think, and on a backend that ignores the option', () => {
    expect(reasoningEffortsFor(model(ChatModels.CLAUDE_4_5_HAIKU, ModelBackend.Anthropic))).toEqual([]);
    expect(
      reasoningEffortsFor(model(ChatModels.GEMINI_3_1_PRO_PREVIEW, ModelBackend.Gemini, { can_think: true }))
    ).toEqual([]);
  });

  it('agrees with the provider tables on every model the static adapter tables ship', async () => {
    const rows = (await Promise.all(staticPriceBackends().map(backend => backend.getModelInfo()))).flat();
    const claudeServed = (row: ModelInfo) =>
      (row.backend === ModelBackend.Anthropic || row.backend === ModelBackend.Bedrock) && isClaudeModelId(row.id);

    for (const row of rows.filter(r => r.type === 'text')) {
      const efforts = reasoningEffortsFor(row);
      if (REASONING_SUPPORTED_MODELS.has(row.id) && row.backend === ModelBackend.OpenAI) {
        expect(efforts, row.id).toEqual(OPENAI_LEVELS);
      } else if (row.id === ChatModels.KIMI_K3 || DEEPSEEK_MODELS.has(row.id)) {
        expect(efforts, row.id).toEqual(ALL_BUT_NONE);
      } else if (claudeServed(row) && row.can_think) {
        expect(efforts, row.id).toEqual(expect.arrayContaining(ALL_BUT_NONE));
      } else {
        expect(efforts, row.id).toEqual([]);
      }
    }
  });
});

describe('listModelsContract example', () => {
  it("advertises claude-sonnet-5's real projection, so the docs cannot drift from the adapters", async () => {
    const example = listModelsContract.responses[200].example as { data: { id: string }[] };
    const row = (await new AnthropicBackend('static-price-table').getModelInfo()).find(
      m => m.id === ChatModels.CLAUDE_5_SONNET
    );
    if (!row) throw new Error('claude-sonnet-5 is not in the Anthropic table');

    const projected = toPublicModel(row, {
      reasonsWithinOutputBudget: reasonsWithinOutputBudget(row),
      reasoningEfforts: reasoningEffortsFor(row),
    });
    expect(example.data.find(m => m.id === ChatModels.CLAUDE_5_SONNET)).toEqual({ ...projected, description: null });
  });
});

const ADAPTIVE = { can_think: true, thinkingStyle: 'adaptive' as const };
const opus55 = model(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Anthropic, ADAPTIVE);
const opus55Bedrock = model(ChatModels.CLAUDE_5_5_OPUS_BEDROCK, ModelBackend.Bedrock, ADAPTIVE);
const haiku55 = model(ChatModels.CLAUDE_5_5_HAIKU, ModelBackend.Anthropic, ADAPTIVE);
const legacyClaude = model(ChatModels.CLAUDE_4_5_HAIKU, ModelBackend.Anthropic, { can_think: true });
const nonThinkingClaude = model(ChatModels.CLAUDE_4_5_HAIKU, ModelBackend.Anthropic);
const gpt5 = model(ChatModels.GPT5, ModelBackend.OpenAI, { can_think: true });
const gpt52 = model(ChatModels.GPT5_2, ModelBackend.OpenAI, { can_think: true });

describe('chatReasoningEffortsFor', () => {
  it('offers an adaptive Claude model every level but minimal, with none only where it has an off switch', () => {
    expect(chatReasoningEffortsFor(opus55)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(chatReasoningEffortsFor(opus55Bedrock)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(chatReasoningEffortsFor(haiku55)).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
  });

  it('offers nothing on a legacy or non-thinking Claude model', () => {
    expect(chatReasoningEffortsFor(legacyClaude)).toEqual([]);
    expect(chatReasoningEffortsFor(nonThinkingClaude)).toEqual([]);
  });

  it('adds xhigh on exactly the OpenAI models known to take it', () => {
    for (const id of REASONING_SUPPORTED_MODELS) {
      const expected = OPENAI_XHIGH_REASONING_EFFORT_MODELS.has(id) ? [...OPENAI_LEVELS, 'xhigh'] : OPENAI_LEVELS;
      expect(chatReasoningEffortsFor(model(id, ModelBackend.OpenAI, { can_think: true })), id).toEqual(expected);
    }
    expect(chatReasoningEffortsFor(gpt52)).toEqual([...OPENAI_LEVELS, 'xhigh']);
  });

  it('adds no xhigh on an xhigh model id that its backend never sends effort to', () => {
    expect(chatReasoningEffortsFor(model(ChatModels.GPT5_2_CHAT_LATEST, ModelBackend.OpenAI))).toEqual([]);
  });

  it('is reasoningEffortsFor on every other non-Claude model', () => {
    expect(chatReasoningEffortsFor(gpt5)).toEqual(OPENAI_LEVELS);
    const gemini = model(ChatModels.GEMINI_3_1_PRO_PREVIEW, ModelBackend.Gemini, { can_think: true });
    expect(chatReasoningEffortsFor(gemini)).toEqual([]);
  });
});

describe('clampReasoningEffort', () => {
  it('keeps a listed level', () => {
    expect(clampReasoningEffort('high', ['low', 'high'])).toBe('high');
  });

  it('raises an unlisted level to the next listed one', () => {
    expect(clampReasoningEffort('none', ['low', 'medium'])).toBe('low');
    expect(clampReasoningEffort('medium', ['low', 'high'])).toBe('high');
  });

  it('lowers a level above every listed one to the highest', () => {
    expect(clampReasoningEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
  });

  it('is undefined when nothing is listed', () => {
    expect(clampReasoningEffort('low', [])).toBeUndefined();
  });
});

describe('chatReasoningEffortFor', () => {
  it('is undefined without an explicit preference, leaving complexity and the model default to the adapter', () => {
    expect(chatReasoningEffortFor(opus55, undefined)).toBeUndefined();
    expect(chatReasoningEffortFor(gpt5, undefined)).toBeUndefined();
  });

  it('sends an explicit level an adaptive Claude model takes unchanged', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(chatReasoningEffortFor(opus55, effort), effort).toBe(effort);
      expect(chatReasoningEffortFor(haiku55, effort), effort).toBe(effort);
    }
    expect(chatReasoningEffortFor(haiku55, 'none')).toBe('none');
  });

  it('clamps the levels an adaptive Claude model does not list to the next one up', () => {
    expect(chatReasoningEffortFor(opus55, 'minimal')).toBe('low');
    expect(chatReasoningEffortFor(opus55, 'none')).toBe('low');
    expect(chatReasoningEffortFor(haiku55, 'minimal')).toBe('low');
  });

  it('withholds every level from a legacy, non-thinking or unknown Claude model', () => {
    const unknownClaude = model('claude-unknown-9', ModelBackend.Anthropic);
    for (const effort of ALL) {
      expect(chatReasoningEffortFor(legacyClaude, effort), effort).toBeUndefined();
      expect(chatReasoningEffortFor(nonThinkingClaude, effort), effort).toBeUndefined();
      expect(chatReasoningEffortFor(unknownClaude, effort), effort).toBeUndefined();
    }
  });

  it('passes an OpenAI model every level it lists unchanged', () => {
    for (const effort of OPENAI_LEVELS) {
      expect(chatReasoningEffortFor(gpt5, effort), effort).toBe(effort);
    }
  });

  it('lowers xhigh to high on an OpenAI model that rejects it, so a stored Claude Extra High never reaches it', () => {
    expect(chatReasoningEffortFor(gpt5, 'xhigh')).toBe('high');
    for (const id of [ChatModels.GPT5_1, ChatModels.O3, ChatModels.O4_MINI]) {
      expect(chatReasoningEffortFor(model(id, ModelBackend.OpenAI, { can_think: true }), 'xhigh'), id).toBe('high');
    }
    const catalogOnly = model('gpt-6-sol', ModelBackend.OpenAI, { can_think: true, openaiReasoningEffort: true });
    expect(chatReasoningEffortFor(catalogOnly, 'xhigh')).toBe('high');
  });

  it('keeps xhigh on GPT-5.2, which takes it', () => {
    expect(chatReasoningEffortFor(gpt52, 'xhigh')).toBe('xhigh');
  });

  it('keeps xhigh on Kimi K3 and DeepSeek, whose adapters map it to their top level', () => {
    expect(chatReasoningEffortFor(model(ChatModels.KIMI_K3, ModelBackend.Kimi, { can_think: true }), 'xhigh')).toBe(
      'xhigh'
    );
    for (const id of DEEPSEEK_MODELS) {
      expect(chatReasoningEffortFor(model(id, ModelBackend.DeepSeek, { can_think: true }), 'xhigh'), id).toBe('xhigh');
    }
  });

  it("raises a level below a non-Claude model's lowest listed one, so a stored none never reaches OpenAI", () => {
    expect(chatReasoningEffortFor(gpt5, 'none')).toBe('low');
    expect(chatReasoningEffortFor(gpt5, 'minimal')).toBe('low');
    expect(chatReasoningEffortFor(model(ChatModels.KIMI_K3, ModelBackend.Kimi, { can_think: true }), 'none')).toBe(
      'minimal'
    );
  });

  it('passes the preference through unchanged on a non-Claude model that lists no level', () => {
    for (const effort of ALL) {
      expect(chatReasoningEffortFor(model('some-new-model', ModelBackend.Ollama), effort), effort).toBe(effort);
    }
  });
});
