import { describe, expect, it } from 'vitest';
import type { ChatReplyStats } from '@shared/chat';
import {
  cacheReadShare,
  describeReplyStats,
  formatDuration,
  formatShare,
  generationRate,
  liveReplyStats,
  replyStats,
  thinkingShare,
  withPhase,
} from './replyStats';
import type { TurnProgress } from './statusLine';

const base: ChatReplyStats = { totalMs: 20_000, modelMs: 20_000, toolMs: 0 };

describe('thinkingShare', () => {
  it('is thinking time over the whole reply', () => {
    expect(thinkingShare({ ...base, reasoningMs: 5000 })).toBe(0.25);
  });

  it('is absent for a reply that did not think, or took no time', () => {
    expect(thinkingShare(base)).toBeNull();
    expect(thinkingShare({ ...base, totalMs: 0, reasoningMs: 10 })).toBeNull();
    expect(thinkingShare(undefined)).toBeNull();
  });

  it('never claims more than the whole', () => {
    expect(thinkingShare({ ...base, reasoningMs: 30_000 })).toBe(1);
  });
});

describe('generationRate', () => {
  it("takes the server's timings, measured or estimated as the server's rate says", () => {
    expect(generationRate({ usage: { rate: { evalTokens: 478, evalMs: 20_000 } } })).toEqual({
      tokens: 478,
      ms: 20_000,
      estimated: false,
    });
    expect(generationRate({ usage: { rate: { evalTokens: 40, evalMs: 2000, estimated: true } } })?.estimated).toBe(
      true
    );
  });

  it('estimates a hosted reply from the generation main timed per request', () => {
    expect(
      generationRate({ stats: { ...base, generation: { tokens: 200, ms: 4000 } }, usage: { outputTokens: 201 } })
    ).toEqual({
      tokens: 200,
      ms: 4000,
      estimated: true,
    });
  });

  it('falls back to the timed generation when a server reported a rate it spent no time on', () => {
    expect(
      generationRate({
        stats: { ...base, generation: { tokens: 99, ms: 2000 } },
        usage: { outputTokens: 100, rate: { evalTokens: 100, evalMs: 0 } },
      })
    ).toEqual({ tokens: 99, ms: 2000, estimated: true });
  });

  it('has no speed where no request could be timed', () => {
    expect(generationRate({ stats: base, usage: { outputTokens: 200 } })).toBeNull();
    expect(generationRate({ usage: { outputTokens: 200 } })).toBeNull();
    expect(generationRate({ stats: { ...base, generation: { tokens: 0, ms: 300 } } })).toBeNull();
  });
});

describe('cacheReadShare', () => {
  it('is cache reads over new input, reads and writes on a hosted reply', () => {
    expect(
      cacheReadShare({ inputTokens: 1000, cacheReadInputTokens: 8000, cacheCreationInputTokens: 1000 })
    ).toBeCloseTo(0.8);
  });

  it("is llama-server's cached over cached plus evaluated", () => {
    expect(
      cacheReadShare({
        inputTokens: 4000,
        rate: { evalTokens: 10, evalMs: 100, promptTokens: 1000, promptMs: 50, cachedPromptTokens: 3000 },
      })
    ).toBe(0.75);
  });

  it("is vLLM's cached over its prompt count, which includes them, when no evaluated count came", () => {
    expect(cacheReadShare({ inputTokens: 4000, rate: { evalTokens: 10, evalMs: 100, cachedPromptTokens: 1000 } })).toBe(
      0.25
    );
  });

  it('is absent when nothing about the cache was reported', () => {
    expect(cacheReadShare({ inputTokens: 4000, outputTokens: 10 })).toBeNull();
    expect(cacheReadShare(undefined)).toBeNull();
  });

  it('is a real zero when the server reported an empty cache', () => {
    expect(cacheReadShare({ inputTokens: 500, cacheReadInputTokens: 0 })).toBe(0);
  });
});

describe('formatting', () => {
  it('formats durations at the scale they are read', () => {
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(12_340)).toBe('12.3s');
    expect(formatDuration(187_000)).toBe('3m 7s');
  });

  it('keeps a small share from rounding away', () => {
    expect(formatShare(0.3)).toBe('30%');
    expect(formatShare(0.001)).toBe('<1%');
    expect(formatShare(0)).toBe('0%');
  });
});

describe('replyStats', () => {
  it('lists a self-hosted thinking reply in order, marking the estimates', () => {
    const rows = replyStats({
      stats: {
        ...base,
        firstTokenMs: 400,
        reasoningMs: 5000,
        reasoningTokens: 120,
        derived: ['reasoningTokens'],
      },
      usage: {
        inputTokens: 900,
        outputTokens: 480,
        rate: { evalTokens: 480, evalMs: 19_000, promptTokens: 900, promptMs: 300, loadMs: 1200 },
      },
    });

    expect(rows.map(row => [row.id, row.value])).toEqual([
      ['thinking', '5.0s'],
      ['total', '20.0s'],
      ['thinkingShare', '25%'],
      ['thinkingTokens', '~120'],
      ['tokens', '480'],
      ['speed', '25.3 tok/s'],
      ['promptSpeed', '3000 tok/s'],
      ['firstToken', '400ms'],
      ['load', '1.2s'],
    ]);
    expect(rows.find(row => row.id === 'thinkingTokens')?.estimate).toMatch(/thinking frames/);
    expect(rows.find(row => row.id === 'speed')?.estimate).toBeUndefined();
  });

  it('marks thinking time and its share as estimates when main derived them', () => {
    const rows = replyStats({ stats: { ...base, reasoningMs: 2000, derived: ['reasoningMs'] } });

    expect(rows.find(row => row.id === 'thinking')?.value).toBe('~2.0s');
    expect(rows.find(row => row.id === 'thinkingShare')?.value).toBe('~10%');
  });

  it('marks a hosted speed as timed by the app', () => {
    const rows = replyStats({
      stats: { ...base, generation: { tokens: 200, ms: 4000 } },
      usage: { inputTokens: 100, outputTokens: 201, cacheReadInputTokens: 900, reasoningTokens: 50 },
    });

    expect(rows.find(row => row.id === 'speed')).toMatchObject({ value: '~50.0 tok/s' });
    expect(rows.find(row => row.id === 'cacheShare')?.value).toBe('90%');
    expect(rows.find(row => row.id === 'thinkingTokens')?.value).toBe('50');
  });

  // Both as main stores them: a 3000-token call that arrived whole, then a 20-token answer
  // over 300ms; and 1900 tokens of thinking the server never streamed, then 100 of text.
  it('rates a hosted reply by its tokens over the time spent producing them', () => {
    const speed = (stats: ChatReplyStats, outputTokens: number) =>
      replyStats({ stats, usage: { outputTokens } }).find(row => row.id === 'speed')?.value;

    expect(speed({ ...base, generation: { tokens: 19, ms: 300 } }, 3020)).toBe('~63.3 tok/s');
    expect(speed({ ...base, generation: { tokens: 2000, ms: 20_306 } }, 2000)).toBe('~98.5 tok/s');
  });

  it('times the first token from the request, as main stored it', () => {
    const rows = replyStats({ stats: { ...base, firstTokenMs: 1250 } });
    expect(rows.find(row => row.id === 'firstToken')?.value).toBe('1.3s');
  });

  it('shows what an older reply, stored before stats, still carries', () => {
    const rows = replyStats({ usage: { inputTokens: 300, outputTokens: 48, rate: { evalTokens: 48, evalMs: 2000 } } });

    expect(rows.map(row => row.id)).toEqual(['tokens', 'speed']);
    expect(replyStats({})).toEqual([]);
  });

  it('counts whole seconds while live, and leaves the total, share and speed to the status line', () => {
    const rows = replyStats(
      { stats: { ...base, totalMs: 12_600, reasoningMs: 3200, generation: { tokens: 99, ms: 2000 } } },
      { live: true }
    );

    expect(rows.map(row => [row.id, row.value])).toEqual([['thinking', '3s']]);
  });

  it('describes the full set for a title, with what each estimate rests on', () => {
    const text = describeReplyStats(replyStats({ stats: { ...base, reasoningMs: 2000, derived: ['reasoningMs'] } }));

    expect(text?.split('\n')[0]).toBe('Thinking time: ~2.0s (estimated from the wait before the first output)');
    expect(describeReplyStats([])).toBeNull();
  });
});

describe('the live turn', () => {
  const turn: TurnProgress = { startedAt: 10_000, tokens: null };

  it('stamps the request on the first wait and the first token on the first phase that is not one', () => {
    const waited = withPhase(turn, { kind: 'waiting' }, 10_500);
    expect(waited.requestAt).toBe(10_500);
    expect(withPhase(waited, { kind: 'waiting' }, 10_600)).toBe(waited);
    const answered = withPhase(waited, { kind: 'responding' }, 11_000);
    expect(answered.firstTokenAt).toBe(11_000);
    expect(withPhase(answered, { kind: 'waiting' }, 12_000)).toMatchObject({ requestAt: 10_500 });
  });

  it('runs a thinking clock across phases, and leaves an unchanged turn alone', () => {
    let next = withPhase(turn, { kind: 'waiting' }, 10_400);
    next = withPhase(next, { kind: 'thinking' }, 11_000);
    expect(withPhase(next, { kind: 'thinking' }, 11_500)).toBe(next);
    next = withPhase(next, { kind: 'responding' }, 14_000);
    next = withPhase(next, { kind: 'waiting' }, 15_000);
    next = withPhase(next, { kind: 'thinking' }, 16_000);

    expect(next.thinkingMs).toBe(3000);
    expect(liveReplyStats(next, 17_500)).toMatchObject({ reasoningMs: 4500, firstTokenMs: 600 });
  });

  it('times the first token from the turn when no request was seen going out', () => {
    expect(liveReplyStats({ ...turn, firstTokenAt: 10_700 }, 12_000).firstTokenMs).toBe(700);
  });

  it('has no thinking time or first token for a turn that has neither', () => {
    expect(liveReplyStats(turn, 12_000).reasoningMs).toBeUndefined();
    expect(liveReplyStats(turn, 12_000).firstTokenMs).toBeUndefined();
  });
});
