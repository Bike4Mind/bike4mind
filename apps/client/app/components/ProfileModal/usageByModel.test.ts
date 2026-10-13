// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { aggregateUsageByModel, usageModelKey } from './usageByModel';

const model = (id: string, name: string, backend: ModelBackend): ModelInfo =>
  ({ id, name, backend, type: 'text', pricing: {} }) as unknown as ModelInfo;

const models = [
  model('global.anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5 (AWS Bedrock)', ModelBackend.Bedrock),
  model('claude-sonnet-5-5', 'Claude Sonnet 5.5', ModelBackend.Anthropic),
  model('gpt-5.4-mini', 'GPT-5.4 Mini', ModelBackend.OpenAI),
];

describe('usageModelKey', () => {
  it('maps the Bedrock profile id and the API id of one model to the same key', () => {
    expect(usageModelKey('global.anthropic.claude-sonnet-5-5')).toBe(usageModelKey('claude-sonnet-5-5'));
    expect(usageModelKey('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      usageModelKey('claude-haiku-4-5-20251001')
    );
  });

  it('leaves dotted bare ids alone', () => {
    expect(usageModelKey('gpt-4.1')).toBe('gpt-4.1');
  });
});

describe('aggregateUsageByModel', () => {
  it('sums one model recorded under two backend ids into one display-named slice', () => {
    const usage = aggregateUsageByModel(
      [
        { model: 'claude-sonnet-5-5', credits: -103 },
        { model: 'global.anthropic.claude-sonnet-5-5', credits: -50 },
        { model: 'gpt-5.4-mini', credits: -7 },
      ],
      models
    );

    expect(usage).toEqual({ 'Claude Sonnet 5.5': 153, 'GPT-5.4 Mini': 7 });
  });

  it('falls back to the raw id for a model the picker does not list', () => {
    expect(aggregateUsageByModel([{ model: 'retired-model', credits: -4 }], models)).toEqual({ 'retired-model': 4 });
  });
});
