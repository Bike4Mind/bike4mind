import { describe, expect, it } from 'vitest';
import { addUsage, foldUsage, parseStreamEvent } from './streamEvents';

describe('toolStarted', () => {
  it('survives parsing on a content frame', () => {
    expect(parseStreamEvent({ type: 'content', text: '', toolStarted: { name: 'file_write', id: 'c1' } })).toEqual({
      type: 'content',
      text: '',
      toolStarted: { name: 'file_write', id: 'c1' },
    });
  });
});

describe('usage parsing', () => {
  it('keeps the cache counts and the credits the server sends', () => {
    const event = parseStreamEvent({
      type: 'content',
      text: 'x',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 900, cacheCreationInputTokens: 40 },
      credits: { used: 12, usdCost: 0.03 },
    });
    expect(event).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 900, cacheCreationInputTokens: 40 },
      credits: { used: 12, usdCost: 0.03 },
    });
  });
});

describe('foldUsage', () => {
  it('lets a later frame replace counts and adds credits from a separate frame', () => {
    const first = foldUsage(
      undefined,
      parseStreamEvent({ type: 'content', usage: { inputTokens: 5, cacheReadInputTokens: 100 } })!
    );
    const second = foldUsage(first, parseStreamEvent({ type: 'content', usage: { inputTokens: 7, outputTokens: 3 } })!);
    const third = foldUsage(second, parseStreamEvent({ type: 'content', credits: { used: 2, usdCost: 0.01 } })!);
    expect(third).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 100,
      creditsUsed: 2,
      usdCost: 0.01,
    });
  });

  it('stays undefined for a frame that reports nothing', () => {
    expect(foldUsage(undefined, parseStreamEvent({ type: 'content', text: 'x' })!)).toBeUndefined();
  });
});

describe('addUsage', () => {
  it('sums the cache counts and cost across requests', () => {
    expect(
      addUsage(
        { inputTokens: 1, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, usdCost: 0.5 },
        { inputTokens: 2, cacheReadInputTokens: 20, outputTokens: 4, creditsUsed: 3, usdCost: 0.25 }
      )
    ).toEqual({
      inputTokens: 3,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 5,
      outputTokens: 4,
      creditsUsed: 3,
      usdCost: 0.75,
    });
  });
});
