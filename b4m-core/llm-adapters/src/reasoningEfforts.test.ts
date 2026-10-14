import {
  ChatModels,
  isClaudeModelId,
  listModelsContract,
  ModelBackend,
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
import { reasoningEffortsFor } from './reasoningEfforts';
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
    expect(reasoningEffortsFor(model(ChatModels.CLAUDE_4_5_HAIKU, ModelBackend.Anthropic, { can_think: true }))).toEqual(
      ALL
    );
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
