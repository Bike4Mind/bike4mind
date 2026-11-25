import { describe, expect, it } from 'vitest';
import type {
  ChatReplyStats,
  ChatUsage,
  ChatMessage,
  ChatStreamEvent,
  ChatToolCall,
  ChatReplyRound,
} from '@shared/chat';
import {
  cacheReadShare,
  describeReplyStats,
  footerSeparator,
  formatDuration,
  formatShare,
  generationRate,
  liveReplyStats,
  replyLoad,
  replyStats,
  speakReplyStats,
  thinkingShare,
  withPhase,
} from './replyStats';
import { type TurnProgress, contextTokens } from './statusLine';
import { applyLiveEvent } from '@shared/liveReply';
import { callsIn, roundsOf } from './replyRounds';
import { applyReplyDone } from './replyDone';
import { describeTokenRate, formatTokenRate } from './tokenRate';

const base: ChatReplyStats = { totalMs: 20_000, modelMs: 20_000, toolMs: 0 };

describe('thinkingShare', () => {
  it("is the server's thinking count over the output tokens when it sent one, whatever the times say", () => {
    expect(
      thinkingShare({
        stats: { ...base, reasoningMs: 9000, outputMs: 10_000, reasoningTokens: 100 },
        usage: { outputTokens: 400, reasoningTokens: 100 },
      })
    ).toEqual({ share: 0.25, basis: 'tokens', estimated: false });
  });

  it('counts a self-hosted reply by its thinking frames, as an estimate', () => {
    expect(
      thinkingShare({
        stats: { ...base, reasoningMs: 2000, outputMs: 3000, reasoningTokens: 30, derived: ['reasoningTokens'] },
        usage: { outputTokens: 40 },
      })
    ).toEqual({ share: 0.75, basis: 'tokens', estimated: true });
  });

  it('is thinking time over generation time when nothing counted the thinking, leaving out load and prefill', () => {
    const coldLoad: ChatReplyStats = {
      totalMs: 34_000,
      modelMs: 34_000,
      toolMs: 0,
      loadMs: 28_000,
      firstTokenMs: 29_000,
      outputMs: 5000,
      reasoningMs: 2000,
    };
    expect(thinkingShare({ stats: coldLoad, usage: { outputTokens: 40 } })).toEqual({
      share: 0.4,
      basis: 'time',
      estimated: false,
    });
    expect(thinkingShare({ stats: { ...base, outputMs: 10_000, reasoningMs: 5000 } })?.share).toBe(0.5);
  });

  it('has no time share when the thinking time is itself the wait before the first output', () => {
    expect(
      thinkingShare({ stats: { ...base, outputMs: 10_000, reasoningMs: 5000, derived: ['reasoningMs'] } })
    ).toBeNull();
    expect(
      thinkingShare({
        stats: { ...base, outputMs: 10_000, reasoningMs: 5000, derived: ['reasoningMs'] },
        usage: { outputTokens: 1000, reasoningTokens: 600 },
      })
    ).toEqual({ share: 0.6, basis: 'tokens', estimated: false });
  });

  it('is absent for a reply that did not think, or with no generation time or output to measure against', () => {
    expect(thinkingShare({ stats: base })).toBeNull();
    expect(thinkingShare({ stats: base, usage: { outputTokens: 100, reasoningTokens: 0 } })).toBeNull();
    expect(thinkingShare({ stats: { ...base, outputMs: 0, reasoningMs: 10 } })).toBeNull();
    expect(thinkingShare({ stats: { ...base, reasoningMs: 10 } })).toBeNull();
    expect(thinkingShare({ stats: { ...base, outputMs: 1000 }, usage: { reasoningTokens: 50 } })).toBeNull();
    expect(thinkingShare({})).toBeNull();
  });

  it('is absent when a time or count is not finite', () => {
    expect(thinkingShare({ stats: { ...base, outputMs: 1000, reasoningMs: Number.NaN } })).toBeNull();
    expect(thinkingShare({ stats: { ...base, outputMs: Number.NaN, reasoningMs: 10 } })).toBeNull();
    expect(thinkingShare({ stats: { ...base, outputMs: 1000, reasoningMs: Infinity } })).toBeNull();
    expect(thinkingShare({ stats: { ...base, outputMs: Infinity, reasoningMs: 10 } })).toBeNull();
    expect(
      thinkingShare({ stats: { ...base, outputMs: 1000, reasoningMs: 500 }, usage: { outputTokens: Number.NaN } })
        ?.basis
    ).toBe('time');
  });

  it('never claims more than the whole', () => {
    expect(thinkingShare({ stats: { ...base, outputMs: 1000, reasoningMs: 30_000 } })?.share).toBe(1);
    expect(thinkingShare({ usage: { outputTokens: 10, reasoningTokens: 50 } })?.share).toBe(1);
  });
});

describe('stats stored in an odd shape', () => {
  const rate = { evalTokens: 40, evalMs: 1250 };
  it.each([
    ['an object', { loadMs: 1 }],
    ['a number', 5],
    ['null', null],
    ['a string', 'loadMs'],
  ])('reads a reply whose derived is %s without throwing', (_, derived) => {
    const stats = { ...base, derived } as unknown as ChatReplyStats;
    const rows = replyStats({ stats, usage: { outputTokens: 40, rate } });
    expect(rows.find(row => row.id === 'total')?.value).toBe('20.0s');
    expect(() => thinkingShare({ stats, usage: { outputTokens: 40 } })).not.toThrow();
    expect(() => replyLoad({ stats })).not.toThrow();
    expect(() => generationRate({ stats, usage: { rate } })).not.toThrow();
    expect(() => liveReplyStats({ startedAt: 0 } as TurnProgress, 1000, stats)).not.toThrow();
  });

  it('shows only the counts of a reply whose stats are not an object', () => {
    const rows = replyStats({ stats: 'broken' as unknown as ChatReplyStats, usage: { outputTokens: 40 } });
    expect(rows.find(row => row.id === 'total')).toBeUndefined();
    expect(rows.find(row => row.id === 'tokens')?.value).toBe('40');
  });
});

describe('replyLoad', () => {
  it("takes main's counted load once it is long enough to name, and none the server reported itself", () => {
    const reported = { rate: { evalTokens: 40, evalMs: 1300, loadMs: 5000 } };
    expect(replyLoad({ stats: { ...base, loadMs: 28_000 } })).toEqual({ load: 28_000, wait: 0 });
    expect(replyLoad({ stats: { ...base, loadMs: 40 } })).toBeNull();
    expect(replyLoad({ stats: { ...base, loadMs: Infinity } })).toBeNull();
    expect(replyLoad({ stats: base })).toBeNull();
    expect(replyLoad({ stats: { ...base, outputMs: 4_000 }, usage: reported })).toBeNull();
  });

  it('keeps a wait main worked out apart from a model load, and either alone or both', () => {
    expect(replyLoad({ stats: { ...base, waitMs: 28_000 } })).toEqual({ load: 0, wait: 28_000 });
    expect(replyLoad({ stats: { ...base, waitMs: 40 } })).toBeNull();
    expect(replyLoad({ stats: { ...base, loadMs: 30_000, waitMs: 5_000 } })).toEqual({ load: 30_000, wait: 5_000 });
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

  it('reads the cached count a reply too short to rate carries on its usage', () => {
    expect(cacheReadShare({ inputTokens: 4000, outputTokens: 1, cachedPromptTokens: 3000 })).toBe(0.75);
    expect(
      cacheReadShare({
        inputTokens: 8000,
        cachedPromptTokens: 3000,
        rate: { evalTokens: 10, evalMs: 100, estimated: true, cachedPromptTokens: 1000 },
      })
    ).toBe(0.5);
  });

  it('takes the whole prompt from the usage when a llama-server reply mixes rated and unrated rounds', () => {
    // The rated round evaluated 100 of its prompt; the unrated one reports only its cached 200.
    expect(
      cacheReadShare({
        inputTokens: 1000,
        cachedPromptTokens: 200,
        rate: { evalTokens: 10, evalMs: 100, promptTokens: 100, promptMs: 10, cachedPromptTokens: 600 },
      })
    ).toBe(0.8);
  });

  it('never claims more than the whole prompt was cached', () => {
    expect(cacheReadShare({ inputTokens: 4000, cachedPromptTokens: 5000 })).toBe(1);
    expect(cacheReadShare({ inputTokens: 2000, rate: { evalTokens: 1, evalMs: 1, cachedPromptTokens: 3000 } })).toBe(1);
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

  it('never prints NaN for a duration that is not a number', () => {
    expect(formatDuration(Number.NaN)).toBe('0ms');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
  });

  it('drops the row of a missing or non-finite duration', () => {
    const ids = (stats: Partial<ChatReplyStats>) =>
      replyStats({ stats: { ...base, ...stats } as ChatReplyStats }).map(row => row.id);

    expect(ids({ totalMs: Number.NaN })).not.toContain('total');
    expect(ids({ totalMs: undefined })).not.toContain('total');
    expect(ids({ reasoningMs: Number.POSITIVE_INFINITY })).not.toContain('thinking');
    expect(ids({ firstTokenMs: Number.NaN })).not.toContain('firstToken');
    expect(ids({})).toContain('total');
  });

  it('rounds before picking the unit, so no edge reads as the next unit up', () => {
    expect(formatDuration(999.4)).toBe('999ms');
    expect(formatDuration(999.6)).toBe('1.0s');
    expect(formatDuration(59_940)).toBe('59.9s');
    expect(formatDuration(59_950)).toBe('1m 0s');
    expect(formatDuration(119_600)).toBe('2m 0s');
    expect(formatDuration(-5)).toBe('0ms');
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
        loadMs: 1200,
        outputMs: 18_200,
        firstTokenMs: 1600,
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
      ['total', '18.8s'],
      ['thinkingShare', '~25%'],
      ['thinkingTokens', '~120'],
      ['tokens', '480'],
      ['speed', '25.3 tok/s'],
      ['promptSpeed', '3000 tok/s'],
      ['firstToken', '1.6s'],
      ['load', '1.2s'],
    ]);
    expect(rows.find(row => row.id === 'thinkingTokens')?.estimate).toMatch(/thinking frames/);
    expect(rows.find(row => row.id === 'thinkingShare')?.label).toBe('Thinking (tokens)');
    expect(rows.find(row => row.id === 'speed')?.estimate).toBeUndefined();
  });

  it('marks thinking time as an estimate when main derived it, and then shows no time share', () => {
    const rows = replyStats({ stats: { ...base, outputMs: 15_000, reasoningMs: 2000, derived: ['reasoningMs'] } });

    expect(rows.find(row => row.id === 'thinking')?.value).toBe('~2.0s');
    expect(rows.find(row => row.id === 'thinkingShare')).toBeUndefined();
  });

  it('shares out the thinking of a reply whose server counted it by tokens, and says so', () => {
    const rows = replyStats({
      stats: { ...base, reasoningMs: 9000, outputMs: 10_000 },
      usage: { outputTokens: 400, reasoningTokens: 100 },
    });

    expect(rows.find(row => row.id === 'thinkingShare')).toMatchObject({ value: '25%', label: 'Thinking (tokens)' });
  });

  it('shares out the thinking of a reply with no thinking count by generation time, and says so', () => {
    const rows = replyStats({
      stats: { ...base, modelMs: 20_000, firstTokenMs: 12_000, outputMs: 8_000, reasoningMs: 2_000 },
      usage: { outputTokens: 300 },
    });

    expect(rows.find(row => row.id === 'thinkingShare')).toMatchObject({ value: '25%', label: 'Thinking (time)' });
  });

  it('reads a cold-loaded self-hosted reply as its own time plus a named model load', () => {
    const rows = replyStats({
      stats: {
        totalMs: 34_000,
        modelMs: 34_000,
        toolMs: 0,
        loadMs: 28_000,
        outputMs: 5_200,
        firstTokenMs: 28_800,
        firstTokenLoadMs: 28_000,
        reasoningMs: 1_300,
      },
      usage: { outputTokens: 40, rate: { evalTokens: 40, evalMs: 1_250, promptMs: 500, loadMs: 28_000 } },
    });
    const row = (id: string) => rows.find(candidate => candidate.id === id);

    expect(row('total')?.value).toBe('6.0s');
    expect(row('total')?.note).toBe('leaves out 28.0s of model load');
    expect(row('load')).toEqual({ id: 'load', label: 'Model load', value: '28.0s' });
    expect(row('speed')?.value).toBe('32.0 tok/s');
    expect(row('thinkingShare')).toMatchObject({ value: '25%', label: 'Thinking (time)' });
    expect(row('firstToken')?.note).toBe('includes 28.0s of model load');
    expect(describeReplyStats(rows)).toContain('Thinking (time): 25%');
  });

  it('notes on the first token only the load of the request it was timed on', () => {
    const stats = { ...base, outputMs: 4_000, loadMs: 38_000, firstTokenMs: 28_800 };
    const firstToken = (extra: Partial<ChatReplyStats>) =>
      replyStats({ stats: { ...stats, ...extra } }).find(row => row.id === 'firstToken');
    expect(firstToken({ firstTokenLoadMs: 28_000 })?.note).toBe('includes 28.0s of model load');
    expect(firstToken({})?.note).toBeUndefined();
  });

  it("names a wait main worked out from llama-server's timings as a server wait, and none on a warm reply", () => {
    const derived = replyStats({
      stats: { ...base, waitMs: 9_000, firstTokenMs: 9_500, firstTokenWaitMs: 9_000 },
    });
    expect(derived.find(row => row.id === 'load')).toEqual({
      id: 'load',
      label: 'Server wait',
      value: '9.0s',
      note: 'load, queue or connection',
    });
    expect(describeReplyStats(derived)).toContain('Server wait: 9.0s (load, queue or connection)');
    // Derived, it can be a connection on every request: kept in the total, not taken out of it.
    expect(derived.find(row => row.id === 'total')).toMatchObject({
      value: '20.0s',
      note: 'includes 9.0s of server wait',
    });
    expect(derived.find(row => row.id === 'firstToken')?.note).toBe('includes 9.0s of server wait');

    const warm = replyStats({
      stats: { ...base, loadMs: 40, firstTokenMs: 300 },
      usage: { outputTokens: 400, rate: { evalTokens: 400, evalMs: 19_000, loadMs: 40 } },
    });
    expect(warm.find(row => row.id === 'load')).toBeUndefined();
    expect(warm.find(row => row.id === 'total')).toMatchObject({ value: '20.0s' });
    expect(warm.find(row => row.id === 'total')?.note).toBeUndefined();
  });

  it('keeps a reported load out of the total and a derived wait in it, when a continued reply has both', () => {
    const rows = replyStats({
      stats: { ...base, totalMs: 40_000, loadMs: 30_000, waitMs: 5_000, firstTokenMs: 5_500, firstTokenWaitMs: 5_000 },
    });
    const row = (id: string) => rows.find(candidate => candidate.id === id);

    expect(row('total')).toMatchObject({
      value: '10.0s',
      note: 'includes 5.0s of server wait; leaves out 30.0s of model load',
    });
    expect(row('load')).toEqual({
      id: 'load',
      label: 'Model load',
      value: '30.0s',
      note: 'plus 5.0s of server wait',
    });
    expect(row('firstToken')?.note).toBe('includes 5.0s of server wait');
    expect(footerSeparator('total', 'load', 'Model load')).toBe(' + ');
  });

  it('keeps a long wait the server did not break down in the total, named as the wait for the first token', () => {
    const rows = replyStats({
      stats: { totalMs: 34_000, modelMs: 34_000, toolMs: 2_000, firstTokenMs: 27_000, outputMs: 5_000 },
      usage: { outputTokens: 40, rate: { evalTokens: 39, evalMs: 1_200, estimated: true, untimedTokens: 1 } },
    });

    expect(rows.find(row => row.id === 'total')).toMatchObject({
      value: '34.0s',
      note: 'includes 2.0s running tools and waiting for approval, and 27.0s waiting for the first token',
    });
    expect(rows.find(row => row.id === 'load')).toBeUndefined();
  });

  it('marks a hosted speed as timed by the app', () => {
    const rows = replyStats({
      stats: { ...base, generation: { tokens: 200, ms: 4000, untimedTokens: 1 } },
      usage: { inputTokens: 100, outputTokens: 201, cacheReadInputTokens: 900, reasoningTokens: 50 },
    });

    expect(rows.find(row => row.id === 'speed')).toMatchObject({ value: '~50.0 tok/s' });
    expect(rows.find(row => row.id === 'speed')?.note).toBeUndefined();
    expect(rows.find(row => row.id === 'cacheShare')?.value).toBe('90%');
    expect(rows.find(row => row.id === 'thinkingTokens')?.value).toBe('50');
  });

  it('notes on the speed how many output tokens were timed when some were not', () => {
    const note = (evalTokens: number, outputTokens: number) =>
      replyStats({ usage: { outputTokens, rate: { evalTokens, evalMs: 10_000 } } }).find(row => row.id === 'speed')
        ?.note;

    expect(note(480, 3000)).toBe('timed 480 of 3.0k output tokens');
    expect(note(3000, 3000)).toBeUndefined();
  });

  it('notes untimed tokens on a hosted reply only when the gap shows at the displayed precision', () => {
    const note = (timed: number, output: number, rated = false, untimedTokens?: number) =>
      replyStats({
        stats: { ...base, generation: { tokens: timed, ms: 10_000, untimedTokens } },
        usage: { outputTokens: output, ...(rated ? { rate: { evalTokens: timed, evalMs: 10_000 } } : {}) },
      }).find(r => r.id === 'speed')?.note;

    expect(note(19, 3020)).toBe('timed 19 of 3.0k output tokens');
    expect(note(19, 3020, false, 1)).toBe('timed 19 of 3.0k output tokens');
    expect(note(2999, 3000)).toBeUndefined();
    expect(note(2999, 3000, true)).toBeUndefined();
  });

  it("counts only the reply's own output against the timed tokens, not a sub-agent's", () => {
    const rows = replyStats({
      stats: { ...base, generation: { tokens: 480, ms: 10_000, untimedTokens: 1, outputTokens: 500 } },
      usage: { outputTokens: 3_000 },
    });
    expect(rows.find(row => row.id === 'speed')?.note).toBe('timed 480 of 500 output tokens');
    expect(rows.find(row => row.id === 'tokens')?.value).toBe('3.0k');
    const whole = replyStats({
      stats: { ...base, generation: { tokens: 499, ms: 10_000, untimedTokens: 1, outputTokens: 500 } },
      usage: { outputTokens: 3_000 },
    });
    expect(whole.find(row => row.id === 'speed')?.note).toBeUndefined();
  });

  it('does not note the token a hosted round leaves out of its timing by design', () => {
    const note = (output: number, untimedTokens: number, timed = output - untimedTokens) =>
      replyStats({
        stats: { ...base, generation: { tokens: timed, ms: 10_000, untimedTokens } },
        usage: { outputTokens: output },
      }).find(r => r.id === 'speed')?.note;

    expect(note(200, 1)).toBeUndefined();
    expect(note(500, 3)).toBeUndefined();
    expect(note(3020, 1, 19)).toBe('timed 19 of 3.0k output tokens');
    expect(note(3000, 1, 2000)).toBe('timed 2.0k of 3.0k output tokens');
  });

  it('does not note the first read an estimated self-hosted rate leaves out', () => {
    const note = (untimedTokens: number | undefined) =>
      replyStats({
        usage: { outputTokens: 200, rate: { evalTokens: 199, evalMs: 5000, estimated: true, untimedTokens } },
      }).find(r => r.id === 'speed')?.note;

    expect(note(1)).toBeUndefined();
    expect(note(undefined)).toBe('timed 199 of 200 output tokens');
  });

  // Both as main stores them: a 3000-token call that arrived whole, then a 20-token answer
  // over 300ms; and 1900 tokens of thinking the server never streamed, then 100 of text.
  it('rates a hosted reply by its tokens over the time spent producing them', () => {
    const speed = (stats: ChatReplyStats, outputTokens: number) =>
      replyStats({ stats, usage: { outputTokens } }).find(row => row.id === 'speed')?.value;

    expect(speed({ ...base, generation: { tokens: 19, ms: 300 } }, 3020)).toBe('~63.3 tok/s');
    expect(speed({ ...base, generation: { tokens: 2000, ms: 20_306 } }, 2000)).toBe('~98.5 tok/s');
  });

  it("shows llama-server's draft acceptance, with the counts behind it", () => {
    const rows = replyStats({
      usage: { outputTokens: 120, rate: { evalTokens: 120, evalMs: 2000, draftTokens: 90, draftAccepted: 44 } },
    });

    expect(rows.find(row => row.id === 'draft')).toEqual({ id: 'draft', value: '49%', note: '44 of 90 draft tokens' });
    expect(describeReplyStats(rows)?.split('\n').at(-1)).toBe('Draft accepted: 49% (44 of 90 draft tokens)');
    const undrafted = replyStats({
      usage: { rate: { evalTokens: 120, evalMs: 2000, draftTokens: 0, draftAccepted: 0 } },
    });
    expect(undrafted.map(row => row.id)).not.toContain('draft');
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

  it('speaks the rows as one sentence, an estimate read as about', () => {
    const rows = replyStats({ stats: { ...base, reasoningMs: 2000, derived: ['reasoningMs'] } });

    expect(speakReplyStats(rows.slice(0, 2), '3 credits')).toBe(
      'Thinking time about 2.0s, estimated from the wait before the first output; Total time 20.0s; Cost 3 credits.'
    );
  });

  it('says what the total takes in when tools ran', () => {
    const rows = replyStats({ stats: { totalMs: 9000, modelMs: 5900, toolMs: 3100 } });

    expect(describeReplyStats(rows)).toBe('Total time: 9.0s (includes 3.1s running tools and waiting for approval)');
    expect(replyStats({ stats: base })[0]?.note).toBeUndefined();
  });

  it('leaves out a tool time and a load time that are not finite', () => {
    const total = replyStats({ stats: { ...base, toolMs: Infinity } }).find(row => row.id === 'total');
    expect(total?.note).toBeUndefined();
    const rows = replyStats({ usage: { outputTokens: 10, rate: { evalTokens: 10, evalMs: 500, loadMs: Infinity } } });
    expect(rows.find(row => row.id === 'load')).toBeUndefined();
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

  it('shows no first token for a turn whose request it never saw go out', () => {
    expect(liveReplyStats({ ...turn, firstTokenAt: 10_700 }, 12_000).firstTokenMs).toBeUndefined();

    // Opened mid-reply: a later request's wait must not stand in for the first one.
    let joined: TurnProgress = { ...turn, requestAt: null };
    joined = withPhase(joined, { kind: 'waiting' }, 12_000);
    joined = withPhase(joined, { kind: 'responding' }, 12_400);
    expect(joined.requestAt).toBeNull();
    expect(liveReplyStats(joined, 13_000).firstTokenMs).toBeUndefined();
    expect(liveReplyStats(joined, 13_000, { ...base, firstTokenMs: 900 }).firstTokenMs).toBe(900);
  });

  it("builds on a continued reply's earlier runs, taking the server's running thinking count over theirs", () => {
    const earlier: ChatReplyStats = {
      ...base,
      firstTokenMs: 900,
      reasoningMs: 2000,
      reasoningTokens: 50,
      derived: ['reasoningTokens'],
    };
    const live = liveReplyStats({ ...turn, firstTokenAt: 10_400, thinkingMs: 1500 }, 12_000, earlier);
    expect(live).toMatchObject({ firstTokenMs: 900, reasoningMs: 3500 });

    const value = (usage: ChatUsage) =>
      replyStats({ stats: live, usage }, { live: true }).find(row => row.id === 'thinkingTokens');
    expect(value({ outputTokens: 400, reasoningTokens: 120 })).toEqual({ id: 'thinkingTokens', value: '120' });
    expect(value({ outputTokens: 400 })?.value).toBe('~50');
  });

  it('has no thinking time or first token for a turn that has neither', () => {
    expect(liveReplyStats(turn, 12_000).reasoningMs).toBeUndefined();
    expect(liveReplyStats(turn, 12_000).firstTokenMs).toBeUndefined();
  });
});

describe('replyRounds', () => {
  function call(id: string, name = 'bash_execute'): ChatToolCall {
    return { id, name, input: {}, status: 'done' };
  }

  function message(fields: Partial<ChatMessage>): ChatMessage {
    return {
      id: 'm1',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      ...fields,
    } as ChatMessage;
  }

  describe('roundsOf', () => {
    it('collapses a message stored before rounds existed into one round', () => {
      const drawn = roundsOf(message({ content: 'All done.', toolCalls: [call('a'), call('b')] }));

      expect(drawn).toEqual([{ text: 'All done.', toolCallIds: ['a', 'b'] }]);
    });

    it('folds wordless rounds into the round whose prose introduced them', () => {
      const drawn = roundsOf(
        message({
          content: 'Running the tests.\n\nGreen.',
          rounds: [
            { text: 'Running the tests.', toolCallIds: ['a'] },
            { text: '', toolCallIds: ['b'] },
            { text: '', toolCallIds: ['c'] },
            { text: 'Green.', toolCallIds: [] },
          ],
          toolCalls: [call('a'), call('b'), call('c')],
        })
      );

      expect(drawn).toEqual([
        { text: 'Running the tests.', toolCallIds: ['a', 'b', 'c'] },
        { text: 'Green.', toolCallIds: [] },
      ]);
    });

    it('keeps a round that carries only reasoning, which now has a row of its own', () => {
      const drawn = roundsOf(
        message({
          content: 'Found it.',
          rounds: [
            { text: '', toolCallIds: [], reasoning: 'planning' },
            { text: 'Found it.', toolCallIds: [] },
          ],
        })
      );

      expect(drawn).toEqual([
        { text: '', toolCallIds: [], reasoning: 'planning' },
        { text: 'Found it.', toolCallIds: [] },
      ]);
    });

    it('carries the reasoning of a wordless round into the round it is folded into', () => {
      const drawn = roundsOf(
        message({
          rounds: [
            { text: 'Looking.', toolCallIds: ['a'], reasoning: 'first thought' },
            { text: '', toolCallIds: ['b'], reasoning: 'second thought' },
          ],
          toolCalls: [call('a'), call('b')],
        })
      );

      expect(drawn).toEqual([
        { text: 'Looking.', toolCallIds: ['a', 'b'], reasoning: 'first thought\n\nsecond thought' },
      ]);
    });

    it('folds a wordless round with no reasoning without inventing an empty one', () => {
      const drawn = roundsOf(
        message({
          rounds: [
            { text: 'Looking.', toolCallIds: ['a'] },
            { text: '', toolCallIds: ['b'] },
          ],
          toolCalls: [call('a'), call('b')],
        })
      );

      expect(drawn).toEqual([{ text: 'Looking.', toolCallIds: ['a', 'b'] }]);
    });

    it('keeps the calls of a reasoning-only round that went on to run tools', () => {
      const drawn = roundsOf(
        message({
          rounds: [
            { text: '', toolCallIds: [], reasoning: 'planning' },
            { text: '', toolCallIds: ['a'] },
          ],
          toolCalls: [call('a')],
        })
      );

      expect(drawn.flatMap(round => round.toolCallIds)).toEqual(['a']);
    });

    it('keeps a leading wordless round rather than dropping its calls', () => {
      const drawn = roundsOf(
        message({
          content: 'Found it.',
          rounds: [
            { text: '', toolCallIds: ['a'] },
            { text: 'Found it.', toolCallIds: [] },
          ],
          toolCalls: [call('a')],
        })
      );

      expect(drawn).toEqual([
        { text: '', toolCallIds: ['a'] },
        { text: 'Found it.', toolCallIds: [] },
      ]);
    });
  });

  describe('callsIn', () => {
    it('takes only its own calls, in the message order, ignoring ids that are gone', () => {
      const calls = callsIn({ text: '', toolCallIds: ['c', 'a', 'gone'] }, [call('a'), call('b'), call('c')]);

      expect(calls.map(entry => entry.id)).toEqual(['a', 'c']);
    });
  });

  describe('roundsOf while a reply streams', () => {
    const ev = (event: { type: string; text?: string; call?: ChatToolCall }) =>
      ({ sessionId: 's1', messageId: 'm1', ...event }) as ChatStreamEvent;

    it('never moves a call out of the round it was first drawn in', () => {
      const events = [
        ev({ type: 'delta', text: 'Reading.' }),
        ev({ type: 'tool-start', call: call('a') }),
        ev({ type: 'delta', text: '\n' }),
        ev({ type: 'tool-start', call: call('b') }),
        ev({ type: 'delta', text: '\n\nNow editing.' }),
        ev({ type: 'tool-start', call: call('c') }),
        ev({ type: 'delta', text: 'Done.' }),
      ];
      let live = message({});
      const seen = new Map<string, number>();
      for (const event of events) {
        live = applyLiveEvent(live, event);
        roundsOf(live).forEach((round, index) =>
          round.toolCallIds.forEach(id => {
            expect(seen.get(id) ?? index).toBe(index);
            seen.set(id, index);
          })
        );
      }
    });
  });
});

describe('replyDone', () => {
  type ReplyDoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

  const ARTIFACT = '<artifact type="text/html" title="Demo">\n<b>hi</b>\n</artifact>';

  /** A reply as it looks mid-stream: the deltas that arrived, artifact markup and all. */
  function streaming(rounds: ChatReplyRound[]): ChatMessage {
    return {
      id: 'm1',
      role: 'assistant',
      createdAt: '2026-01-01T00:00:00.000Z',
      content: rounds.map(round => round.text).join('\n\n'),
      rounds,
    };
  }

  function done(event: Partial<ReplyDoneEvent>): ReplyDoneEvent {
    return { type: 'done', sessionId: 's1', messageId: 'm1', content: '', ...event };
  }

  describe('applyReplyDone', () => {
    it('takes the stripped rounds off the event, so the thread stops drawing raw markup', () => {
      // The regression. Main strips per round before it announces the reply, so the event holds
      // clean prose while the message still holds the deltas that carried the markup.
      const message = streaming([{ text: `Here you go.\n\n${ARTIFACT}`, toolCallIds: ['c1'] }]);
      const settled = applyReplyDone(
        message,
        done({ content: 'Here you go.', rounds: [{ text: 'Here you go.', toolCallIds: ['c1'] }] })
      );

      const drawn = roundsOf(settled)
        .map(round => round.text)
        .join('\n');
      expect(drawn).not.toContain('<artifact');
      expect(drawn).toBe('Here you go.');
    });

    it('drops the streamed rounds when the event omits them, so content is what draws', () => {
      // A turn that ran no tools: main sends no `rounds`, and roundsOf rebuilds the single round
      // from `content`. Defaulting to the message's own rounds here would keep the raw markup.
      const message = streaming([{ text: `Made it.\n\n${ARTIFACT}`, toolCallIds: [] }]);
      const settled = applyReplyDone(message, done({ content: 'Made it.' }));

      expect(settled.rounds).toBeUndefined();
      expect(roundsOf(settled).map(round => round.text)).toEqual(['Made it.']);
    });

    it('keeps every round of a resumed turn, not just the ones after the interruption', () => {
      // Continue streams into the SAME message and its done carries seeded + new rounds.
      const message = streaming([
        { text: 'First.', toolCallIds: ['c1'] },
        { text: `Second.\n\n${ARTIFACT}`, toolCallIds: [] },
      ]);
      const settled = applyReplyDone(
        message,
        done({
          content: 'First.\n\nSecond.',
          rounds: [
            { text: 'First.', toolCallIds: ['c1'] },
            { text: 'Second.', toolCallIds: [] },
          ],
        })
      );

      expect(roundsOf(settled).map(round => round.text)).toEqual(['First.', 'Second.']);
    });

    it('carries the reply fields the event brings', () => {
      const settled = applyReplyDone(
        streaming([{ text: 'x', toolCallIds: [] }]),
        done({
          content: 'x',
          stopReason: 'tool_turn_limit',
          contextSnapshot: { model: 'test', inputTokens: 100, overhead: [] },
          artifacts: [{ id: 'a1', type: 'html', mimeType: 'text/html', title: 'Demo', content: '<b>hi</b>' }],
        })
      );

      expect(settled.stopReason).toBe('tool_turn_limit');
      expect(settled.contextSnapshot?.inputTokens).toBe(100);
      expect(settled.artifacts).toHaveLength(1);
    });

    it('keeps what streamed for the fields the event leaves out', () => {
      const message: ChatMessage = {
        ...streaming([{ text: 'x', toolCallIds: ['c1'] }]),
        toolCalls: [{ id: 'c1', name: 'bash_execute', input: { command: 'ls' }, status: 'done' }],
      };
      const settled = applyReplyDone(message, done({ content: 'x' }));

      expect(settled.toolCalls).toHaveLength(1);
      expect(settled.stopReason).toBeUndefined();
    });

    /**
     * The settled reply is the window's only copy until the conversation is reloaded, so a usage
     * dropped here is a usage the composer's context indicator cannot read: it went to "--" the
     * instant the turn it was measuring ended, and came back only on a reload.
     */
    it('carries the usage, which is what the context indicator is read off', () => {
      const settled = applyReplyDone(
        streaming([{ text: 'x', toolCallIds: [] }]),
        done({ content: 'x', usage: { inputTokens: 1357, cacheReadInputTokens: 11_136, outputTokens: 5996 } })
      );

      expect(settled.usage?.inputTokens).toBe(1357);
      expect(contextTokens(settled)).toBe(12_493);
    });

    // A terminal event with no usage on it leaves whatever the stream already folded in, rather
    // than clearing a figure that was real - see the other `keeps what streamed` case.
    it('keeps a usage the event does not restate', () => {
      const message: ChatMessage = { ...streaming([{ text: 'x', toolCallIds: [] }]), usage: { inputTokens: 900 } };
      expect(applyReplyDone(message, done({ content: 'x' })).usage?.inputTokens).toBe(900);
    });

    it('takes the prompt cache stamp, which only the settled reply carries', () => {
      const stamp = { cachedAt: 1_000, ttl: '1h' as const, model: 'claude-opus-5-5' };
      const message = streaming([{ text: 'x', toolCallIds: [] }]);
      expect(applyReplyDone(message, done({ content: 'x', promptCache: stamp })).promptCache).toEqual(stamp);
    });

    it('takes the stats, so the rail shows the settled figures without a reload', () => {
      const stats = { totalMs: 4000, modelMs: 4000, toolMs: 0, firstTokenMs: 300 };
      const message = streaming([{ text: 'x', toolCallIds: [] }]);
      const settled = applyReplyDone(message, done({ content: 'x', stats }));

      expect(settled.stats).toEqual(stats);
      expect(applyReplyDone(settled, done({ content: 'x' })).stats).toEqual(stats);
    });

    it('leaves the text a reply with no artifact in it streamed', () => {
      const message = streaming([{ text: 'Plain answer.', toolCallIds: [] }]);
      const settled = applyReplyDone(message, done({ content: 'Plain answer.' }));

      expect(roundsOf(settled).map(round => round.text)).toEqual(['Plain answer.']);
    });

    it('carries the quest_complete mark onto the settled reply, and adds none without it', () => {
      const message = streaming([{ text: 'Summary.', toolCallIds: [] }]);
      expect(applyReplyDone(message, done({ content: 'Summary.', questComplete: true })).questComplete).toBe(true);
      expect(applyReplyDone(message, done({ content: 'Summary.' }))).not.toHaveProperty('questComplete');
    });
  });
});

describe('tokenRate', () => {
  describe('formatTokenRate', () => {
    it('shows one decimal under 100 tok/s and whole numbers above', () => {
      expect(formatTokenRate({ evalTokens: 478, evalMs: 20_000 })).toBe('23.9 tok/s');
      expect(formatTokenRate({ evalTokens: 1500, evalMs: 10_000 })).toBe('150 tok/s');
    });

    it('marks an estimate with a tilde', () => {
      expect(formatTokenRate({ evalTokens: 40, evalMs: 2000, estimated: true })).toBe('~20.0 tok/s');
    });

    it.each([undefined, null, { evalTokens: 0, evalMs: 100 }, { evalTokens: 10, evalMs: 0 }])(
      'shows nothing without a measurement: %j',
      rate => {
        expect(formatTokenRate(rate)).toBeNull();
      }
    );
  });

  describe('describeTokenRate', () => {
    it('adds prompt, load and draft lines only where reported', () => {
      expect(
        describeTokenRate({
          evalTokens: 478,
          evalMs: 20_000,
          promptTokens: 1200,
          promptMs: 1500,
          loadMs: 2300,
          draftTokens: 245,
          draftAccepted: 120,
        })
      ).toBe(
        [
          'Generation: 23.9 tok/s (478 tokens in 20.0s)',
          'Prompt: 800 tok/s (1.2k tokens in 1.5s)',
          'Load (total): 2.3s',
          'Draft acceptance: 49% (120 of 245)',
        ].join('\n')
      );
      expect(describeTokenRate({ evalTokens: 10, evalMs: 400 })).toBe('Generation: 25.0 tok/s (10 tokens in 400ms)');
    });

    it('says how much of the output was timed when some rounds were not', () => {
      expect(describeTokenRate({ evalTokens: 40, evalMs: 2000 }, 100)).toBe(
        'Generation: 20.0 tok/s (timed 40 of 100 output tokens in 2.0s)'
      );
      expect(describeTokenRate({ evalTokens: 40, evalMs: 2000 }, 40)).toBe(
        'Generation: 20.0 tok/s (40 tokens in 2.0s)'
      );
    });

    it('leaves out the tokens left untimed by design, and a count that rounds like the output', () => {
      expect(describeTokenRate({ evalTokens: 199, evalMs: 4000, untimedTokens: 1 }, 200)).toBe(
        'Generation: 49.8 tok/s (199 tokens in 4.0s)'
      );
      expect(describeTokenRate({ evalTokens: 9999, evalMs: 4000 }, 10_000)).toBe(
        'Generation: 2500 tok/s (10k tokens in 4.0s)'
      );
    });

    it('says an estimate was timed by the app', () => {
      expect(describeTokenRate({ evalTokens: 40, evalMs: 2000, estimated: true })).toBe(
        'Generation: ~20.0 tok/s (40 tokens in 2.0s)\nEstimated from stream timing; the server reported no timings'
      );
    });

    it('is null with nothing measured', () => {
      expect(describeTokenRate(undefined)).toBeNull();
    });
  });
});
