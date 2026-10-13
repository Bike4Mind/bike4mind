// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CREDITS_PER_USD_COST, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { dedupePricingRows, formatCreditsPer1M, pricingRowKey, textModelPriceCells } from './modelPricingRows';

const perM = (usd: number) => usd / 1_000_000;

function textModel(id: string, backend: ModelBackend, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: id as ModelInfo['id'],
    type: 'text',
    name: id,
    backend,
    contextWindow: 1_000_000,
    max_tokens: 32_000,
    supportsImageVariation: false,
    pricing: { 1_000_000: { input: perM(2), output: perM(8) } },
    ...overrides,
  };
}

describe('pricingRowKey', () => {
  it('collapses a dated snapshot and its alias on the same backend', () => {
    expect(pricingRowKey(textModel('gpt-4.1-2025-04-14', ModelBackend.OpenAI))).toBe(
      pricingRowKey(textModel('gpt-4.1', ModelBackend.OpenAI))
    );
    expect(pricingRowKey(textModel('claude-haiku-4-5-20251001', ModelBackend.Anthropic))).toBe(
      pricingRowKey(textModel('claude-haiku-4-5', ModelBackend.Anthropic))
    );
  });

  it('keeps Bedrock and the native API apart', () => {
    expect(pricingRowKey(textModel('global.anthropic.claude-opus-5-5', ModelBackend.Bedrock))).not.toBe(
      pricingRowKey(textModel('claude-opus-5-5', ModelBackend.Anthropic))
    );
  });
});

describe('dedupePricingRows', () => {
  it('lists each model once, keeping the priced twin', () => {
    const rows = dedupePricingRows([
      textModel('gpt-4.1', ModelBackend.OpenAI, { name: 'gpt-4.1', pricing: {} }),
      textModel('gpt-4.1-2025-04-14', ModelBackend.OpenAI, { name: 'GPT-4.1' }),
      textModel('global.anthropic.claude-opus-5-5', ModelBackend.Bedrock),
      textModel('claude-opus-5-5', ModelBackend.Anthropic),
    ]);

    expect(rows.map(row => row.id)).toEqual([
      'gpt-4.1-2025-04-14',
      'global.anthropic.claude-opus-5-5',
      'claude-opus-5-5',
    ]);
  });

  it('keeps two Bedrock versions of a model apart', () => {
    const rows = dedupePricingRows([
      textModel('anthropic.claude-3-5-sonnet-20240620-v1:0', ModelBackend.Bedrock),
      textModel('us.anthropic.claude-3-5-sonnet-20241022-v2:0', ModelBackend.Bedrock),
    ]);

    expect(rows).toHaveLength(2);
  });

  it('keeps twins billed at different prices, so neither price is hidden', () => {
    const rows = dedupePricingRows([
      textModel('gpt-4o', ModelBackend.OpenAI),
      textModel('gpt-4o-2024-05-13', ModelBackend.OpenAI, {
        pricing: { 128_000: { input: perM(5), output: perM(15) } },
      }),
      textModel('gpt-4o-2024-08-06', ModelBackend.OpenAI),
    ]);

    expect(rows.map(row => row.id)).toEqual(['gpt-4o', 'gpt-4o-2024-05-13']);
  });

  it('keeps the first of two equally priced twins', () => {
    const rows = dedupePricingRows([
      textModel('gpt-4.1-2025-04-14', ModelBackend.OpenAI),
      textModel('gpt-4.1', ModelBackend.OpenAI),
    ]);

    expect(rows.map(row => row.id)).toEqual(['gpt-4.1-2025-04-14']);
  });
});

describe('textModelPriceCells', () => {
  it('shows credits per 1M tokens, so cheap models no longer round to 1', () => {
    const nano = textModel('gpt-4.1-nano-2025-04-14', ModelBackend.OpenAI, {
      pricing: { 1_047_576: { input: perM(0.1), output: perM(0.4) } },
    });

    expect(textModelPriceCells(nano)).toEqual({
      inputCost: formatCreditsPer1M(0.1 * CREDITS_PER_USD_COST),
      outputCost: formatCreditsPer1M(0.4 * CREDITS_PER_USD_COST),
    });
    expect(textModelPriceCells(nano).inputCost).not.toBe(textModelPriceCells(nano).outputCost);
  });

  it('is N/A for an unpriced model', () => {
    expect(textModelPriceCells(textModel('x', ModelBackend.OpenAI, { pricing: {} }))).toEqual({
      inputCost: 'N/A',
      outputCost: 'N/A',
    });
  });
});

describe('formatCreditsPer1M', () => {
  it('keeps up to two decimals and groups thousands', () => {
    expect(formatCreditsPer1M(0.02)).toBe((0.02).toLocaleString());
    expect(formatCreditsPer1M(75.5)).toBe((75.5).toLocaleString());
    expect(formatCreditsPer1M(1.23456)).toBe((1.23).toLocaleString());
    expect(formatCreditsPer1M(10_000)).toBe((10_000).toLocaleString());
  });
});
