import { describe, expect, it } from 'vitest';
import { readReplyStats } from './replyStats';

const totals = { totalMs: 5000, modelMs: 4000, toolMs: 1000 };

describe('readReplyStats', () => {
  it('keeps well-formed stats whole', () => {
    const stats = {
      ...totals,
      loadMs: 1200,
      firstTokenLoadMs: 1200,
      outputMs: 2000,
      firstTokenMs: 1500,
      reasoningMs: 800,
      reasoningTokens: 40,
      generation: { tokens: 100, ms: 2000, untimedTokens: 1, outputTokens: 120 },
      waitMs: 900,
      firstTokenWaitMs: 900,
      derived: ['reasoningTokens', 'reasoningMs'],
    };
    expect(readReplyStats(stats)).toEqual(stats);
  });

  it.each([
    ['an object', { loadMs: 1 }],
    ['a number', 7],
    ['null', null],
    ['a string', 'loadMs'],
    ['an array holding unknown names', ['nope', 3, null, 'loadMs', 'reasoningMs']],
  ])('ignores derived as %s', (_, derived) => {
    const read = readReplyStats({ ...totals, derived });
    expect(read).toMatchObject(totals);
    if (Array.isArray(derived)) expect(read?.derived).toEqual(['reasoningMs']);
    else expect(read).not.toHaveProperty('derived');
  });

  it('drops optional fields of the wrong type and a malformed generation', () => {
    const read = readReplyStats({
      ...totals,
      loadMs: '5',
      waitMs: NaN,
      firstTokenWaitMs: '1',
      outputMs: Infinity,
      reasoningMs: NaN,
      firstTokenMs: null,
      generation: { tokens: 'many', ms: 10 },
    });
    expect(read).toEqual(totals);
    expect(readReplyStats({ ...totals, generation: 4 })).toEqual(totals);
  });

  it.each([undefined, null, 5, 'stats', [], {}, { totalMs: 1, modelMs: 1 }, { ...totals, totalMs: NaN }])(
    'reads %j as no stats',
    value => {
      expect(readReplyStats(value)).toBeUndefined();
    }
  );
});
