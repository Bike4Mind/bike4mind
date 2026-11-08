import { describe, expect, it } from 'vitest';
import type { ChatReplyStats, ChatUsage } from '@shared/chat';
import {
  cacheReadShare,
  describeReplyStats,
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
import type { TurnProgress } from './statusLine';

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

describe('replyLoad', () => {
  it("takes main's counted load, else the server's reported one, once it is long enough to name", () => {
    const reported = { rate: { evalTokens: 40, evalMs: 1300, loadMs: 5000 } };
    expect(replyLoad({ stats: { ...base, loadMs: 28_000 } })).toEqual({ ms: 28_000, kind: 'load' });
    expect(replyLoad({ stats: base, usage: reported })).toEqual({ ms: 5000, kind: 'load' });
    expect(replyLoad({ stats: { ...base, loadMs: 40 } })).toBeNull();
    expect(replyLoad({ stats: { ...base, loadMs: Infinity } })).toBeNull();
    expect(replyLoad({ stats: base })).toBeNull();
    // Stored with outputMs, so a missing loadMs is none, whatever the server reported.
    expect(replyLoad({ stats: { ...base, outputMs: 4_000 }, usage: reported })).toBeNull();
    // A Continue of an old reply stores loadMs 0 with no outputMs: the summed load is not one request's.
    expect(replyLoad({ stats: { ...base, loadMs: 0 }, usage: reported })).toBeNull();
  });

  it("holds an old reply's summed load to the per-request rule: only a reply that ran no tools was one request", () => {
    const warm = { rate: { evalTokens: 600, evalMs: 20_000, loadMs: 1_500 } };
    expect(replyLoad({ stats: { ...base, toolMs: 4_000 }, usage: warm })).toBeNull();
    expect(replyLoad({ stats: base, usage: warm })).toEqual({ ms: 1_500, kind: 'load' });
    expect(replyLoad({ stats: base, usage: { rate: { evalTokens: 600, evalMs: 20_000, loadMs: 900 } } })).toBeNull();
    expect(replyLoad({ usage: warm })).toBeNull();
  });

  it('names a wait main worked out as a server wait, not a model load', () => {
    expect(replyLoad({ stats: { ...base, loadMs: 28_000, derived: ['loadMs'] } })).toEqual({
      ms: 28_000,
      kind: 'wait',
    });
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

  it('reads a cold reply stored before loads were kept from the load its server reported', () => {
    const rows = replyStats({
      stats: { totalMs: 34_000, modelMs: 34_000, toolMs: 0, firstTokenMs: 28_800 },
      usage: { outputTokens: 40, rate: { evalTokens: 40, evalMs: 1_250, promptMs: 500, loadMs: 28_000 } },
    });
    const row = (id: string) => rows.find(candidate => candidate.id === id);

    expect(row('total')).toMatchObject({ value: '6.0s', note: 'leaves out 28.0s of model load' });
    expect(row('load')).toEqual({ id: 'load', label: 'Model load', value: '28.0s' });
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
      stats: { ...base, loadMs: 9_000, firstTokenMs: 9_500, firstTokenLoadMs: 9_000, derived: ['loadMs'] },
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

  it('says only the part of a load or wait a run before Continue did not record is unknown', () => {
    const unrecorded = 'any load or wait in a run before Continue, which did not record it';
    const none = replyStats({ stats: { ...base, outputMs: 4_000, loadPartial: true, firstTokenMs: 400 } });
    expect(none.find(row => row.id === 'total')).toMatchObject({ value: '20.0s', note: `includes ${unrecorded}` });
    expect(none.find(row => row.id === 'load')).toBeUndefined();

    const wait = replyStats({
      stats: { ...base, outputMs: 4_000, loadMs: 9_000, loadPartial: true, firstTokenMs: 400, derived: ['loadMs'] },
    });
    expect(wait.find(row => row.id === 'total')).toMatchObject({
      value: '20.0s',
      note: `includes 9.0s of server wait, and ${unrecorded}`,
    });
    expect(wait.find(row => row.id === 'load')).toMatchObject({
      label: 'Server wait',
      value: '9.0s',
      note: 'load, queue or connection; not counting a run before Continue, which did not record it',
    });

    const load = replyStats({
      stats: { ...base, outputMs: 4_000, loadMs: 9_000, loadPartial: true, firstTokenMs: 400 },
    });
    expect(load.find(row => row.id === 'total')).toMatchObject({
      value: '11.0s',
      note: `includes ${unrecorded}; leaves out 9.0s of model load`,
    });
    expect(load.find(row => row.id === 'load')).toMatchObject({
      label: 'Model load',
      note: 'not counting a run before Continue, which did not record it',
    });
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
