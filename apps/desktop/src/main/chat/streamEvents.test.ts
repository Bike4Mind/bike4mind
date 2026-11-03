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

  it('keeps the thinking tokens and the 1-hour cache writes', () => {
    const event = parseStreamEvent({
      type: 'tool_use',
      tools: [],
      usage: { outputTokens: 900, reasoningTokens: 700, cacheCreationInputTokens: 40, cacheWrite1hInputTokens: 30 },
    });
    expect(foldUsage(undefined, event!)).toEqual({
      outputTokens: 900,
      reasoningTokens: 700,
      cacheCreationInputTokens: 40,
      cacheWrite1hInputTokens: 30,
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

  it('sums thinking tokens and 1-hour cache writes, absent staying absent', () => {
    expect(
      addUsage(
        { outputTokens: 10, reasoningTokens: 6, cacheWrite1hInputTokens: 4 },
        { outputTokens: 20, reasoningTokens: 15 }
      )
    ).toEqual({ outputTokens: 30, reasoningTokens: 21, cacheWrite1hInputTokens: 4 });
    expect(addUsage({ outputTokens: 1 }, { outputTokens: 2 })).toEqual({ outputTokens: 3 });
  });

  it('sums a local server rate beside the token counts', () => {
    expect(
      addUsage(
        { outputTokens: 10, rate: { evalTokens: 10, evalMs: 500 } },
        { outputTokens: 30, rate: { evalTokens: 30, evalMs: 1500, loadMs: 200 } }
      )
    ).toEqual({ outputTokens: 40, rate: { evalTokens: 40, evalMs: 2000, loadMs: 200 } });
  });
});

describe('the local rate on a frame', () => {
  const frame = {
    type: 'content' as const,
    stopReason: 'stop',
    usage: { outputTokens: 12 },
    rate: { evalTokens: 12, evalMs: 600, estimated: true },
  };

  it('folds into the usage from a local transport', () => {
    expect(foldUsage(undefined, frame)).toEqual({
      outputTokens: 12,
      rate: { evalTokens: 12, evalMs: 600, estimated: true },
    });
  });

  it('is stripped from a hosted server frame by parsing', () => {
    expect(foldUsage(undefined, parseStreamEvent(frame)!)).toEqual({ outputTokens: 12 });
  });
});
