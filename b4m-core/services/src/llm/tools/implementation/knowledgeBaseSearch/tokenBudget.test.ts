import { describe, it, expect, vi } from 'vitest';
import {
  boundByTokenBudget,
  boundPassagesByTokenBudget,
  clipToCodePointBoundary,
  servedPassageText,
} from './tokenBudget';
import type { SemanticChunkResult } from '../../../../dataLakeService/semanticDataLakeSearch';

function hit(overrides: Partial<SemanticChunkResult> = {}): SemanticChunkResult {
  return {
    chunkId: 'c1',
    fileId: 'f1',
    fileName: 'Doc.pdf',
    fileTags: [],
    chunkText: 'passage body',
    score: 0.9,
    ...overrides,
  };
}

describe('clipToCodePointBoundary', () => {
  it('leaves short text untouched', () => {
    expect(clipToCodePointBoundary('hello', 10)).toBe('hello');
  });

  it('drops an orphaned high surrogate at the cut boundary rather than emitting it', () => {
    const emoji = '😀'; // one code point, two UTF-16 units
    const text = `a${emoji}b`;
    // Cut lands exactly between the emoji's two surrogate halves.
    expect(clipToCodePointBoundary(text, 2)).toBe('a');
  });

  it('keeps a fully-included surrogate pair intact', () => {
    const emoji = '😀';
    const text = `a${emoji}b`;
    expect(clipToCodePointBoundary(text, 3)).toBe(`a${emoji}`);
  });
});

describe('servedPassageText', () => {
  it('trims and returns the whole passage when under budget', () => {
    const { text, clipped } = servedPassageText(hit({ chunkText: '  hello world  ' }), 100);
    expect(text).toBe('hello world');
    expect(clipped).toBe(false);
  });

  it('clips at the code-point boundary and appends an ellipsis when over budget', () => {
    const { text, clipped } = servedPassageText(hit({ chunkText: 'a'.repeat(20) }), 5);
    expect(clipped).toBe(true);
    expect(text).toBe(`${'a'.repeat(5)}\u2026`);
  });
});

describe('boundByTokenBudget', () => {
  it('tokenBudget <= 0 disables the budget: yields min(maxItems, costs.length), the pre-#1955 bound', () => {
    const result = boundByTokenBudget([10, 20, 30, 40], { tokenBudget: 0, maxItems: 2 });
    expect(result).toEqual({ keptCount: 2, tokensUsed: 0, budgetBound: false });
  });

  it('a negative tokenBudget also disables the budget (same as 0)', () => {
    const result = boundByTokenBudget([10, 20, 30], { tokenBudget: -1, maxItems: 3 });
    expect(result).toEqual({ keptCount: 3, tokensUsed: 0, budgetBound: false });
  });

  it('admits the first passage even when it alone exceeds the budget', () => {
    const result = boundByTokenBudget([500], { tokenBudget: 100, maxItems: 5 });
    expect(result).toEqual({ keptCount: 1, tokensUsed: 500, budgetBound: false });
  });

  it('stops at the first passage that would overflow the budget, once at least one is kept', () => {
    // 100 + 100 = 200 (fits a 250 budget); + 100 = 300 would overflow -> stop before the 3rd.
    const result = boundByTokenBudget([100, 100, 100, 100], { tokenBudget: 250, maxItems: 4 });
    expect(result).toEqual({ keptCount: 2, tokensUsed: 200, budgetBound: true });
  });

  it('keeps everything when the budget exceeds the whole result set - no notice, no bound', () => {
    const result = boundByTokenBudget([10, 20, 30], { tokenBudget: 1000, maxItems: 10 });
    expect(result).toEqual({ keptCount: 3, tokensUsed: 60, budgetBound: false });
  });

  it('maxItems (the passage-count ceiling) still caps the walk even under a generous budget', () => {
    const result = boundByTokenBudget([10, 10, 10, 10, 10], { tokenBudget: 1000, maxItems: 2 });
    expect(result).toEqual({ keptCount: 2, tokensUsed: 20, budgetBound: false });
  });

  it('empty costs yields nothing kept, no throw', () => {
    expect(boundByTokenBudget([], { tokenBudget: 100, maxItems: 5 })).toEqual({
      keptCount: 0,
      tokensUsed: 0,
      budgetBound: false,
    });
  });
});

describe('boundPassagesByTokenBudget', () => {
  const tokenizerOf = (costPerCall: number | number[]) => {
    let i = 0;
    return {
      countTokens: vi.fn(async () => {
        const cost = Array.isArray(costPerCall) ? costPerCall[i] : costPerCall;
        i++;
        return cost;
      }),
    };
  };

  it('tokenBudget <= 0 short-circuits without calling the tokenizer', async () => {
    const tokenizer = tokenizerOf(999);
    const results = [hit({ chunkId: 'a' }), hit({ chunkId: 'b' }), hit({ chunkId: 'c' })];
    const bound = await boundPassagesByTokenBudget(results, {
      tokenBudget: 0,
      maxPassages: 2,
      maxChunkChars: 1000,
      tokenizer,
    });
    expect(bound.kept.map(r => r.chunkId)).toEqual(['a', 'b']);
    expect(bound.budgetBound).toBe(false);
    expect(tokenizer.countTokens).not.toHaveBeenCalled();
  });

  it('empty results short-circuits without calling the tokenizer', async () => {
    const tokenizer = tokenizerOf(10);
    const bound = await boundPassagesByTokenBudget([], {
      tokenBudget: 500,
      maxPassages: 5,
      maxChunkChars: 1000,
      tokenizer,
    });
    expect(bound).toEqual({ kept: [], tokensUsed: 0, budgetBound: false });
    expect(tokenizer.countTokens).not.toHaveBeenCalled();
  });

  it('prices the SERVED (clipped) text, not the raw stored chunk', async () => {
    // Raw chunk is 20 chars; maxChunkChars clips it to 5 + an ellipsis. If the walk priced the raw
    // text instead, it would cost far more than what is actually served.
    const tokenizer = tokenizerOf(1);
    const results = [hit({ chunkText: 'a'.repeat(20) })];
    await boundPassagesByTokenBudget(results, { tokenBudget: 100, maxPassages: 5, maxChunkChars: 5, tokenizer });
    const priced = tokenizer.countTokens.mock.calls[0][0] as string;
    expect(priced.length).toBeLessThan(20);
    expect(priced.startsWith('aaaaa')).toBe(true);
  });

  it('bounds a mixed set of passage costs, reporting tokensUsed and budgetBound', async () => {
    const tokenizer = tokenizerOf([50, 50, 50]);
    const results = [hit({ chunkId: 'a' }), hit({ chunkId: 'b' }), hit({ chunkId: 'c' })];
    const bound = await boundPassagesByTokenBudget(results, {
      tokenBudget: 120,
      maxPassages: 10,
      maxChunkChars: 1000,
      tokenizer,
    });
    expect(bound.kept.map(r => r.chunkId)).toEqual(['a', 'b']);
    expect(bound.tokensUsed).toBe(100);
    expect(bound.budgetBound).toBe(true);
  });

  it('a tokenizer failure degrades to the plain passage-count bound and warns once, never losing the result', async () => {
    const tokenizer = { countTokens: vi.fn().mockRejectedValue(new Error('tiktoken WASM unavailable')) };
    const logger = { warn: vi.fn() } as never;
    const results = [hit({ chunkId: 'a' }), hit({ chunkId: 'b' }), hit({ chunkId: 'c' })];
    const bound = await boundPassagesByTokenBudget(results, {
      tokenBudget: 500,
      maxPassages: 2,
      maxChunkChars: 1000,
      tokenizer,
      logger,
    });
    expect(bound.kept.map(r => r.chunkId)).toEqual(['a', 'b']);
    expect(bound.budgetBound).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('token-budget pricing failed'), expect.anything());
  });

  it('a tokenizer failure falls back to fallbackCount, NOT the budget-widened maxPassages ceiling', async () => {
    // maxPassages here stands in for a ceiling resolvePassageCeiling already widened to
    // KB_SEARCH_MAX_RESULTS because a budget was configured - falling back to it on pricing
    // failure would serve full-size passages with zero cost control, the one thing a budget
    // exists to prevent. fallbackCount is the caller's plain (non-widened) default instead.
    const tokenizer = { countTokens: vi.fn().mockRejectedValue(new Error('tiktoken WASM unavailable')) };
    const results = Array.from({ length: 10 }, (_, i) => hit({ chunkId: `c${i}` }));
    const bound = await boundPassagesByTokenBudget(results, {
      tokenBudget: 250,
      maxPassages: 10,
      fallbackCount: 5,
      maxChunkChars: 1000,
      tokenizer,
    });
    expect(bound.kept.length).toBe(5);
  });

  it('fallbackCount defaults to maxPassages when omitted', async () => {
    const tokenizer = { countTokens: vi.fn().mockRejectedValue(new Error('boom')) };
    const results = Array.from({ length: 10 }, (_, i) => hit({ chunkId: `c${i}` }));
    const bound = await boundPassagesByTokenBudget(results, {
      tokenBudget: 250,
      maxPassages: 4,
      maxChunkChars: 1000,
      tokenizer,
    });
    expect(bound.kept.length).toBe(4);
  });
});
