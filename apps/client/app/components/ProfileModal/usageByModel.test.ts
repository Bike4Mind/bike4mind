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

  it('keeps near-miss ids of different models apart', () => {
    const pairs = [
      ['gpt-5.4', 'gpt-5.4-mini'],
      ['claude-sonnet-5', 'claude-sonnet-5-5'],
      ['claude-opus-4-20250514', 'claude-opus-4-1-20250805'],
      ['global.anthropic.claude-opus-5', 'global.anthropic.claude-opus-5-5'],
      ['gpt-4.1', 'gpt-4.1-nano'],
    ];
    for (const [a, b] of pairs) expect(usageModelKey(a)).not.toBe(usageModelKey(b));
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

  it('labels by exact id when two differently named models share a key', () => {
    const usage = aggregateUsageByModel(
      [
        { model: 'anthropic.claude-3-5-sonnet-20240620-v1:0', credits: -10 },
        { model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', credits: -20 },
      ],
      [
        model('anthropic.claude-3-5-sonnet-20240620-v1:0', 'Claude 3.5 Sonnet', ModelBackend.Bedrock),
        model('us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'Claude 3.5 Sonnet V2', ModelBackend.Bedrock),
      ]
    );

    expect(usage).toEqual({ 'Claude 3.5 Sonnet': 10, 'Claude 3.5 Sonnet V2': 20 });
  });

  it('does not split a model whose discovered twin differs only in case', () => {
    const usage = aggregateUsageByModel(
      [
        { model: 'gpt-4.1', credits: -1 },
        { model: 'gpt-4.1-2025-04-14', credits: -2 },
      ],
      [model('gpt-4.1-2025-04-14', 'GPT-4.1', ModelBackend.OpenAI), model('gpt-4.1', 'gpt-4.1', ModelBackend.OpenAI)]
    );

    expect(usage).toEqual({ 'GPT-4.1': 3 });
  });

  it('accounts for every credit exactly once', () => {
    const transactions = [
      { model: 'claude-sonnet-5-5', credits: -103 },
      { model: 'global.anthropic.claude-sonnet-5-5', credits: -50 },
      { model: 'us.anthropic.claude-sonnet-5-5', credits: -0.5 },
      { model: 'gpt-5.4-mini', credits: -7 },
      { model: 'retired-model', credits: -4 },
      { metadata: { modelName: 'gpt-5.4-mini' }, credits: -3 },
      { model: 42, credits: -2 },
      { credits: -1 },
    ];
    const usage = aggregateUsageByModel(transactions, models);

    const total = Object.values(usage).reduce((sum, credits) => sum + credits, 0);
    expect(total).toBeCloseTo(transactions.reduce((sum, t) => sum + Math.abs(t.credits), 0));
    expect(usage).toEqual({ 'Claude Sonnet 5.5': 153.5, 'GPT-5.4 Mini': 10, 'retired-model': 4, Unknown: 3 });
  });
});
