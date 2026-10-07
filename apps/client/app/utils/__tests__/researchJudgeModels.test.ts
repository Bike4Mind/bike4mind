import { describe, it, expect } from 'vitest';
import { ModelBackend, RESEARCH_RELEVANCE_MODEL_DEFAULT, type ModelInfo } from '@bike4mind/common';
import { researchDefaultModelLabel, researchJudgeModelOptions } from '../researchJudgeModels';

const model = (over: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'name'>): ModelInfo =>
  ({
    type: 'text',
    backend: ModelBackend.OpenAI,
    contextWindow: 128_000,
    max_tokens: 8192,
    pricing: {},
    supportsImageVariation: false,
    ...over,
  }) as ModelInfo;

describe('researchJudgeModelOptions', () => {
  it('orders by rank then name, and suffixes the backend on shared names', () => {
    const options = researchJudgeModelOptions([
      model({ id: 'b', name: 'Beta', rank: 2 }),
      model({ id: 'haiku-native', name: 'Claude Haiku 4.5', backend: ModelBackend.Anthropic, rank: 1 }),
      model({ id: 'haiku-bedrock', name: 'Claude Haiku 4.5', backend: ModelBackend.Bedrock, rank: 1 }),
      model({ id: 'a', name: 'Alpha' }),
    ]);

    expect(options).toEqual([
      { id: 'haiku-native', label: 'Claude Haiku 4.5 (Anthropic)' },
      { id: 'haiku-bedrock', label: 'Claude Haiku 4.5 (Bedrock)' },
      { id: 'b', label: 'Beta' },
      { id: 'a', label: 'Alpha' },
    ]);
  });

  it.each([
    ['a deep research preview', 'o3-deep-research', 'o3 Deep Research'],
    ['a computer use preview', 'computer-use-preview', 'Computer Use Preview'],
    ['a build model', 'grok-build-0.1', 'grok-build-0.1'],
    ['a code model by id', 'kimi-k2.7-code', 'Kimi K2.7'],
    ['a code model by name', 'kimi-k2', 'Kimi Code'],
    ['a multi-agent model', 'grok-4.20-multi-agent', 'Grok 4.20 Multi-Agent'],
  ])('drops %s, which is not built to judge a snippet', (_label, id, name) => {
    expect(researchJudgeModelOptions([model({ id, name })])).toEqual([]);
  });

  it('keeps a model whose id merely contains a specialty word', () => {
    expect(researchJudgeModelOptions([model({ id: 'codestral-latest', name: 'Codestral' })])).toHaveLength(1);
  });

  it('drops non-text and disabled models', () => {
    expect(
      researchJudgeModelOptions([
        model({ id: 'img', name: 'Image', type: 'image' }),
        model({ id: 'off', name: 'Off', disabled: true }),
      ])
    ).toEqual([]);
  });
});

describe('researchDefaultModelLabel', () => {
  it('names the model the run falls back to', () => {
    expect(researchDefaultModelLabel([model({ id: RESEARCH_RELEVANCE_MODEL_DEFAULT, name: 'GPT-4.1 Mini' })])).toBe(
      'Default (GPT-4.1 Mini)'
    );
  });

  it('says only "Default" when the catalog does not carry it', () => {
    expect(researchDefaultModelLabel([])).toBe('Default');
  });
});
