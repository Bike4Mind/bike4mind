import { describe, it, expect } from 'vitest';
import type { PromptMeta } from '@bike4mind/common';
import { summarizePromptMeta } from './promptMetaSummary';

const meta = (value: Partial<PromptMeta>) => value as PromptMeta;

describe('summarizePromptMeta', () => {
  it('returns nothing for an absent or empty promptMeta', () => {
    expect(summarizePromptMeta(undefined)).toBeUndefined();
    expect(summarizePromptMeta(meta({}))).toBeUndefined();
  });

  it('names the model and its backend', () => {
    expect(summarizePromptMeta(meta({ model: { name: 'claude-opus-5-5', backend: 'anthropic' } }))).toMatchObject({
      model: 'claude-opus-5-5',
      backend: 'anthropic',
    });
  });

  it('lists each tool once, in call order, and counts failed calls', () => {
    const summary = summarizePromptMeta(
      meta({
        functionCalls: [
          { name: 'web_search', success: true },
          { name: 'knowledge_base_search', success: false },
          { name: 'web_search', success: true },
          {},
        ],
      })
    );

    expect(summary?.tools).toEqual(['web_search', 'knowledge_base_search']);
    expect(summary?.toolCallCount).toBe(4);
    expect(summary?.failedToolCallCount).toBe(1);
  });

  it('falls back to narrated tool names when no call was recorded', () => {
    expect(summarizePromptMeta(meta({ narratedToolCall: { toolNames: ['image_generation'] } }))?.tools).toEqual([
      'image_generation',
    ]);
  });

  // The estimate is what the request was priced at before the provider answered; the billed count wins.
  it('takes every token count from the billed basis when the provider reported usage', () => {
    const summary = summarizePromptMeta(
      meta({
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          actualInputTokens: 120,
          actualOutputTokens: 60,
          actualTotalTokens: 999,
        },
      })
    );

    expect(summary).toMatchObject({ inputTokens: 120, outputTokens: 60, totalTokens: 180 });
    expect(summary?.cachedInputTokens).toBeUndefined();
  });

  // A cached turn bills only the uncached tail as actualInputTokens; mixing it with the
  // estimated total gave "2 in, 152 out (7,339 total)".
  it('adds cache reads and writes back into the billed input and derives the total', () => {
    const summary = summarizePromptMeta(
      meta({
        tokenUsage: {
          totalTokens: 7339,
          actualInputTokens: 2,
          actualOutputTokens: 152,
          cacheCreationInputTokens: 7885,
          cacheReadInputTokens: 10,
        },
      })
    );

    expect(summary).toMatchObject({ inputTokens: 7897, cachedInputTokens: 7895, outputTokens: 152, totalTokens: 8049 });
  });

  it('uses the estimate throughout when no billed counts were recorded', () => {
    const summary = summarizePromptMeta(meta({ tokenUsage: { inputTokens: 100, outputTokens: 50 } }));

    expect(summary).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it('labels the retrieval outcome and counts cited sources', () => {
    const summary = summarizePromptMeta(
      meta({
        retrieval: { attempted: true, outcome: 'not_indexed' } as PromptMeta['retrieval'],
        citables: [{}, {}] as PromptMeta['citables'],
      })
    );

    expect(summary?.retrievalOutcome).toBe('Knowledge not indexed');
    expect(summary?.citedSourceCount).toBe(2);
  });

  it('says retrieval did not run when it was recorded but not attempted', () => {
    expect(
      summarizePromptMeta(meta({ retrieval: { attempted: false } as PromptMeta['retrieval'] }))?.retrievalOutcome
    ).toBe('Not run');
  });
});
