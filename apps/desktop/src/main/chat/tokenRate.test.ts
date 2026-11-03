import { describe, expect, it } from 'vitest';
import { addTokenRate, estimatedRate, llamaServerRate, ollamaRate } from './tokenRate';

describe('ollamaRate', () => {
  it('converts the final frame nanoseconds to ms', () => {
    expect(
      ollamaRate({
        eval_count: 240,
        eval_duration: 10_000_000_000,
        prompt_eval_count: 1200,
        prompt_eval_duration: 1_500_000_000,
        load_duration: 2_250_000_000,
      })
    ).toEqual({ evalTokens: 240, evalMs: 10_000, promptTokens: 1200, promptMs: 1500, loadMs: 2250 });
  });

  it('leaves out a prompt with no duration, as a fully cached prompt reports', () => {
    expect(ollamaRate({ eval_count: 10, eval_duration: 500_000_000, prompt_eval_count: 5 })).toEqual({
      evalTokens: 10,
      evalMs: 500,
    });
  });

  it.each([
    { eval_count: 10 },
    { eval_duration: 500_000_000 },
    { eval_count: 10, eval_duration: 0 },
    { eval_count: '10', eval_duration: 500_000_000 },
    { eval_count: 1.5, eval_duration: 500_000_000 },
  ])('reports nothing without a valid generation pair: %j', frame => {
    expect(ollamaRate(frame)).toBeUndefined();
  });
});

describe('llamaServerRate', () => {
  it('reads generation and prompt timings', () => {
    expect(
      llamaServerRate({
        prompt_n: 300,
        prompt_ms: 400,
        prompt_per_second: 750,
        predicted_n: 120,
        predicted_ms: 5000,
        predicted_per_second: 24,
      })
    ).toEqual({ evalTokens: 120, evalMs: 5000, promptTokens: 300, promptMs: 400 });
  });

  it('reads draft acceptance when speculative decoding ran', () => {
    expect(llamaServerRate({ predicted_n: 120, predicted_ms: 5000, draft_n: 90, draft_n_accepted: 44 })).toEqual({
      evalTokens: 120,
      evalMs: 5000,
      draftTokens: 90,
      draftAccepted: 44,
    });
  });

  it('leaves out a draft that proposed nothing', () => {
    expect(llamaServerRate({ predicted_n: 5, predicted_ms: 100, draft_n: 0, draft_n_accepted: 0 })).toEqual({
      evalTokens: 5,
      evalMs: 100,
    });
  });

  it.each([undefined, null, 'x', {}, { predicted_n: 5 }, { predicted_n: 5, predicted_ms: 0 }])(
    'reports nothing without generation timings: %j',
    timings => {
      expect(llamaServerRate(timings)).toBeUndefined();
    }
  );
});

describe('estimatedRate', () => {
  it('times the tokens after the first over the span from first to last', () => {
    expect(estimatedRate(101, { firstAt: 1000, lastAt: 5000, reads: 3 })).toEqual({
      evalTokens: 100,
      evalMs: 4000,
      estimated: true,
    });
  });

  it.each([
    { tokens: undefined, timing: { firstAt: 0, lastAt: 1000, reads: 5 } },
    { tokens: 1, timing: { firstAt: 0, lastAt: 1000, reads: 5 } },
    { tokens: 10, timing: { lastAt: 1000, reads: 5 } },
    { tokens: 10, timing: { firstAt: 1000, reads: 5 } },
    { tokens: 10, timing: { firstAt: 1000, lastAt: 1000, reads: 5 } },
    { tokens: 10, timing: { firstAt: 0, lastAt: 1000, reads: 2 } },
    { tokens: 10, timing: { firstAt: 0, lastAt: 249, reads: 5 } },
  ])('cannot estimate from $tokens tokens over $timing', ({ tokens, timing }) => {
    expect(estimatedRate(tokens, timing)).toBeUndefined();
  });
});

describe('addTokenRate', () => {
  it('sums each pair so the rate stays tokens over time', () => {
    expect(
      addTokenRate(
        { evalTokens: 100, evalMs: 4000, promptTokens: 500, promptMs: 1000, loadMs: 2000 },
        { evalTokens: 50, evalMs: 1000, draftTokens: 40, draftAccepted: 20 }
      )
    ).toEqual({
      evalTokens: 150,
      evalMs: 5000,
      promptTokens: 500,
      promptMs: 1000,
      loadMs: 2000,
      draftTokens: 40,
      draftAccepted: 20,
    });
  });

  it('marks the sum estimated when any part was', () => {
    expect(addTokenRate({ evalTokens: 10, evalMs: 100 }, { evalTokens: 10, evalMs: 100, estimated: true })).toEqual({
      evalTokens: 20,
      evalMs: 200,
      estimated: true,
    });
  });

  it('keeps absent as absent', () => {
    const rate = { evalTokens: 10, evalMs: 100 };
    expect(addTokenRate(undefined, undefined)).toBeUndefined();
    expect(addTokenRate(rate, undefined)).toBe(rate);
    expect(addTokenRate(undefined, rate)).toBe(rate);
  });
});
