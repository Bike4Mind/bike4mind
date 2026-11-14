import { describe, expect, it } from 'vitest';
import type { ChatReplyStats } from '@shared/chat';
import { buildReplyStats, roundGeneration, roundLoad, roundThinking, type StatsRound } from './replyStats';

const round = (timing: StatsRound['timing'], extra: Partial<StatsRound> = {}): StatsRound => ({
  timing,
  reasoningFrames: 0,
  ...extra,
});

describe('roundThinking', () => {
  it('measures the span the thinking frames cover', () => {
    expect(
      roundThinking(
        round(
          {
            startedAt: 0,
            firstTokenAt: 400,
            firstReasoningAt: 400,
            lastReasoningAt: 3_400,
            firstTextAt: 3_450,
            endedAt: 5_000,
          },
          { reasoningFrames: 120 }
        )
      )
    ).toEqual({ ms: 3_000, derived: false });
  });

  it('measures the markers a hosted model sends around thinking it does not show', () => {
    expect(
      roundThinking(
        round({
          startedAt: 0,
          firstTokenAt: 900,
          firstReasoningAt: 900,
          lastReasoningAt: 9_900,
          firstTextAt: 10_000,
          endedAt: 12_000,
        })
      )
    ).toEqual({ ms: 9_000, derived: false });
  });

  it('estimates from the wait before the first text when the server reported thinking it never streamed', () => {
    expect(
      roundThinking(
        round(
          { startedAt: 1_000, firstTokenAt: 7_000, firstTextAt: 7_000, endedAt: 9_000 },
          { usage: { outputTokens: 900, reasoningTokens: 600 } }
        )
      )
    ).toEqual({ ms: 6_000, derived: true });
  });

  it('estimates the same way for thinking blocks only readable once the round stopped', () => {
    expect(
      roundThinking(round({ startedAt: 0, firstTokenAt: 2_000, endedAt: 3_000 }, { reasoning: 'Let me check.' }))
    ).toEqual({ ms: 2_000, derived: true });
  });

  it('estimates rather than measure a single thinking frame, which spans nothing', () => {
    expect(
      roundThinking(
        round(
          {
            startedAt: 0,
            firstTokenAt: 2_000,
            firstReasoningAt: 2_000,
            lastReasoningAt: 2_000,
            firstTextAt: 2_100,
            endedAt: 3_000,
          },
          { reasoningFrames: 1, reasoning: 'Hm.' }
        )
      )
    ).toEqual({ ms: 2_100, derived: true });
  });

  it('counts a lone bare marker as thinking, estimated from the wait before the text', () => {
    expect(
      roundThinking(
        round({
          startedAt: 0,
          firstTokenAt: 3_000,
          firstReasoningAt: 3_000,
          lastReasoningAt: 3_000,
          firstTextAt: 3_000,
          endedAt: 4_000,
        })
      )
    ).toEqual({ ms: 3_000, derived: true });
  });

  it('does not treat a self-hosted lone bare marker as a readable frame', () => {
    expect(
      roundThinking(
        round({
          startedAt: 0,
          firstTokenAt: 3_000,
          firstReasoningAt: 3_000,
          lastReasoningAt: 3_000,
          firstTextAt: 3_000,
          endedAt: 4_000,
        }),
        true
      )
    ).toEqual({ ms: 3_000, derived: true });
  });

  it('estimates to the first text, not to an earlier first output', () => {
    expect(
      roundThinking(
        round(
          { startedAt: 0, firstTokenAt: 1_000, firstTextAt: 6_000, endedAt: 8_000 },
          { usage: { outputTokens: 400, reasoningTokens: 50 } }
        )
      )
    ).toEqual({ ms: 6_000, derived: true });
  });

  it('never reports a negative wait', () => {
    expect(
      roundThinking(
        round({ startedAt: 5_000, firstTokenAt: 4_000, firstTextAt: 4_000, endedAt: 6_000 }, { reasoning: 'x' })
      )
    ).toEqual({ ms: 0, derived: true });
  });

  it('reports nothing for a round that did not think', () => {
    expect(roundThinking(round({ startedAt: 0, firstTokenAt: 100, firstTextAt: 100, endedAt: 900 }))).toBeNull();
    expect(
      roundThinking(round({ startedAt: 0, firstTokenAt: 100, endedAt: 900 }, { usage: { reasoningTokens: 0 } }))
    ).toBeNull();
  });
});

describe('roundGeneration', () => {
  it('times a streamed answer from its first output, leaving out that token', () => {
    expect(
      roundGeneration(
        round({ startedAt: 0, firstTokenAt: 800, firstTextAt: 800, endedAt: 2_800 }, { usage: { outputTokens: 101 } })
      )
    ).toEqual({ tokens: 100, ms: 2_000, untimedTokens: 1 });
  });

  it('times thinking the server never streamed from the request, since it came before the first output', () => {
    expect(
      roundGeneration(
        round(
          { startedAt: 0, firstTokenAt: 20_000, firstTextAt: 20_000, endedAt: 20_306 },
          { usage: { outputTokens: 2_000, reasoningTokens: 1_900 } }
        )
      )
    ).toEqual({ tokens: 2_000, ms: 20_306, untimedTokens: 0 });
  });

  it('keeps a hosted round whose single thinking frame spans nothing as an estimate', () => {
    expect(
      roundGeneration(
        round(
          {
            startedAt: 0,
            firstTokenAt: 2_000,
            firstReasoningAt: 2_000,
            lastReasoningAt: 2_000,
            firstTextAt: 2_100,
            endedAt: 4_100,
          },
          { reasoningFrames: 1, reasoning: 'Hm.', usage: { outputTokens: 500 } }
        )
      )
    ).toEqual({ tokens: 500, ms: 4_100, untimedTokens: 0 });
  });

  it('leaves out a tool call that arrived whole, whose tokens took no measurable time', () => {
    expect(
      roundGeneration(
        round({ startedAt: 0, firstTokenAt: 29_990, endedAt: 30_000 }, { usage: { outputTokens: 3_000 } })
      )
    ).toBeNull();
  });

  it('leaves out a round a server timed itself, a round with no count and one with a single token', () => {
    const timing = { startedAt: 0, firstTokenAt: 100, endedAt: 5_000 };
    expect(
      roundGeneration(round(timing, { usage: { outputTokens: 90, rate: { evalTokens: 90, evalMs: 3_000 } } }))
    ).toBeNull();
    expect(roundGeneration(round(timing))).toBeNull();
    expect(roundGeneration(round(timing, { usage: { outputTokens: 1 } }))).toBeNull();
    expect(roundGeneration(round({ startedAt: 0, endedAt: 5_000 }, { usage: { outputTokens: 90 } }))).toBeNull();
  });
});

describe('buildReplyStats', () => {
  it('rates a tool round that arrived whole by the answer alone, not by its tokens over no time', () => {
    const stats = buildReplyStats({
      endedAt: 32_000,
      rounds: [
        round({ startedAt: 0, firstTokenAt: 29_990, endedAt: 30_000 }, { usage: { outputTokens: 3_000 } }),
        round(
          { startedAt: 31_000, firstTokenAt: 31_500, firstTextAt: 31_500, endedAt: 31_800 },
          { usage: { outputTokens: 20 } }
        ),
      ],
      toolMs: 1_000,
      usage: { outputTokens: 3_020 },
      local: false,
    });
    expect(stats.generation).toEqual({ tokens: 19, ms: 300, untimedTokens: 1 });
  });

  it('rates a tool round from the call starting when the server announced it', () => {
    const stats = buildReplyStats({
      endedAt: 32_000,
      rounds: [
        round({ startedAt: 0, firstTokenAt: 500, endedAt: 30_000 }, { usage: { outputTokens: 3_000 } }),
        round(
          { startedAt: 31_000, firstTokenAt: 31_500, firstTextAt: 31_500, endedAt: 31_800 },
          { usage: { outputTokens: 20 } }
        ),
      ],
      toolMs: 1_000,
      usage: { outputTokens: 3_020 },
      local: false,
    });
    expect(stats.generation).toEqual({ tokens: 3_018, ms: 29_800, untimedTokens: 2 });
  });

  it("rates from the rounds' own usage, leaving out what a sub-agent spent", () => {
    const stats = buildReplyStats({
      endedAt: 3_000,
      rounds: [
        round({ startedAt: 0, firstTokenAt: 500, firstTextAt: 500, endedAt: 2_500 }, { usage: { outputTokens: 201 } }),
      ],
      toolMs: 0,
      usage: { outputTokens: 9_201 },
      local: false,
    });
    expect(stats.generation).toEqual({ tokens: 200, ms: 2_000, untimedTokens: 1 });
  });

  it('counts a hosted round of a single token as left out by design, not as a gap', () => {
    const stats = buildReplyStats({
      endedAt: 4_000,
      rounds: [
        round({ startedAt: 0, firstTokenAt: 500, firstTextAt: 500, endedAt: 600 }, { usage: { outputTokens: 1 } }),
        round(
          { startedAt: 1_000, firstTokenAt: 1_500, firstTextAt: 1_500, endedAt: 3_500 },
          { usage: { outputTokens: 101 } }
        ),
      ],
      toolMs: 0,
      usage: { outputTokens: 102 },
      local: false,
    });
    expect(stats.generation).toEqual({ tokens: 100, ms: 2_000, untimedTokens: 2 });
  });

  it('keeps a round that arrived whole within the span floor as a real gap', () => {
    const stats = buildReplyStats({
      endedAt: 4_000,
      rounds: [
        round({ startedAt: 0, firstTokenAt: 990, endedAt: 1_000 }, { usage: { outputTokens: 50 } }),
        round(
          { startedAt: 1_000, firstTokenAt: 1_500, firstTextAt: 1_500, endedAt: 3_500 },
          { usage: { outputTokens: 101 } }
        ),
      ],
      toolMs: 0,
      usage: { outputTokens: 151 },
      local: false,
    });
    expect(stats.generation).toEqual({ tokens: 100, ms: 2_000, untimedTokens: 1 });
  });

  it('adds a continued run to the earlier generation, and has none when no round could be timed', () => {
    const earlier: ChatReplyStats = {
      totalMs: 9_000,
      modelMs: 9_000,
      toolMs: 0,
      generation: { tokens: 400, ms: 8_000 },
    };
    const next = round(
      { startedAt: 100_000, firstTokenAt: 100_500, firstTextAt: 100_500, endedAt: 102_500 },
      { usage: { outputTokens: 101 } }
    );
    const base = { endedAt: 103_000, toolMs: 0, local: false };
    expect(buildReplyStats({ ...base, rounds: [next], earlier }).generation).toEqual({
      tokens: 500,
      ms: 10_000,
      untimedTokens: 1,
    });
    expect(buildReplyStats({ ...base, rounds: [round(next.timing)] }).generation).toBeUndefined();
  });

  it('leaves a self-hosted reply unrated when its server sent no timings and the stream was too bursty to estimate', () => {
    // 50 tokens in two reads 300ms apart: estimatedRate refuses fewer than three reads, so no rate.
    const rounds = [
      round({ startedAt: 0, firstTokenAt: 1_000, firstTextAt: 1_000, endedAt: 1_300 }, { usage: { outputTokens: 50 } }),
    ];
    const base = { endedAt: 1_400, rounds, toolMs: 0, usage: { outputTokens: 50 } };
    expect(buildReplyStats({ ...base, local: true }).generation).toBeUndefined();
    expect(buildReplyStats({ ...base, local: false }).generation).toEqual({ tokens: 49, ms: 300, untimedTokens: 1 });
  });

  it("leaves the reply's first token to a Continue when the earlier runs streamed nothing", () => {
    const next = round(
      { startedAt: 100_000, firstTokenAt: 100_300, firstTextAt: 100_300, endedAt: 101_000 },
      { usage: { outputTokens: 20 } }
    );
    const silent = buildReplyStats({
      endedAt: 101_000,
      rounds: [next],
      toolMs: 0,
      local: false,
      earlier: { totalMs: 5_000, modelMs: 5_000, toolMs: 0 },
    });
    expect(silent).toMatchObject({ firstTokenMs: 300, totalMs: 6_000, modelMs: 6_000 });
  });

  it('times a plain hosted reply from its request, leaving out the setup before it', () => {
    expect(
      buildReplyStats({
        endedAt: 4_000,
        rounds: [round({ startedAt: 1_100, firstTokenAt: 1_600, firstTextAt: 1_600, endedAt: 3_900 })],
        toolMs: 0,
        usage: { inputTokens: 10, outputTokens: 200 },
        local: false,
      })
    ).toEqual({ totalMs: 2_900, modelMs: 2_800, toolMs: 0, outputMs: 2_300, firstTokenMs: 500 });
  });

  it('sums a tool reply over its rounds and takes the first token from the first round that had one', () => {
    const stats = buildReplyStats({
      endedAt: 10_000,
      rounds: [
        round({ startedAt: 100, endedAt: 300 }),
        round(
          { startedAt: 400, firstTokenAt: 700, firstReasoningAt: 700, lastReasoningAt: 1_700, endedAt: 2_000 },
          { reasoning: 'look first' }
        ),
        round({ startedAt: 6_000, firstTokenAt: 6_500, firstTextAt: 6_500, endedAt: 9_900 }),
      ],
      toolMs: 4_000,
      usage: { outputTokens: 300, reasoningTokens: 120 },
      local: false,
    });
    expect(stats).toEqual({
      totalMs: 9_900,
      modelMs: 5_700,
      toolMs: 4_000,
      outputMs: 4_700,
      firstTokenMs: 300,
      reasoningMs: 1_000,
      reasoningTokens: 120,
    });
  });

  it('never reports a negative time from a clock that stepped back', () => {
    const stats = buildReplyStats({
      endedAt: 900,
      rounds: [round({ startedAt: 1_000, firstTokenAt: 950, endedAt: 990 })],
      toolMs: 0,
      local: false,
    });
    expect(stats).toEqual({ totalMs: 0, modelMs: 0, toolMs: 0, firstTokenMs: 0 });
  });

  it('takes the server thinking count as exact and marks an estimated thinking time', () => {
    const stats = buildReplyStats({
      endedAt: 8_000,
      rounds: [
        round(
          { startedAt: 0, firstTokenAt: 5_000, firstTextAt: 5_000, endedAt: 8_000 },
          { usage: { outputTokens: 800, reasoningTokens: 500 } }
        ),
      ],
      toolMs: 0,
      usage: { outputTokens: 800, reasoningTokens: 500 },
      local: false,
    });
    expect(stats).toMatchObject({ reasoningMs: 5_000, reasoningTokens: 500, derived: ['reasoningMs'] });
  });

  it('estimates a self-hosted model thinking tokens from its frames, capped at the output', () => {
    const rounds = [
      round(
        {
          startedAt: 0,
          firstTokenAt: 300,
          firstReasoningAt: 300,
          lastReasoningAt: 2_300,
          firstTextAt: 2_350,
          endedAt: 3_000,
        },
        { reasoningFrames: 80, reasoning: 'thinking' }
      ),
    ];
    expect(buildReplyStats({ endedAt: 3_000, rounds, toolMs: 0, usage: { outputTokens: 100 }, local: true })).toEqual({
      totalMs: 3_000,
      modelMs: 3_000,
      toolMs: 0,
      outputMs: 2_700,
      firstTokenMs: 300,
      reasoningMs: 2_000,
      reasoningTokens: 80,
      derived: ['reasoningTokens'],
    });
    expect(
      buildReplyStats({ endedAt: 3_000, rounds, toolMs: 0, usage: { outputTokens: 50 }, local: true })
    ).toMatchObject({ reasoningTokens: 50 });
  });

  it('prefers a self-hosted server thinking count over the frames', () => {
    const stats = buildReplyStats({
      endedAt: 3_000,
      rounds: [
        round({ startedAt: 0, firstReasoningAt: 300, lastReasoningAt: 2_300, endedAt: 3_000 }, { reasoningFrames: 80 }),
      ],
      toolMs: 0,
      usage: { outputTokens: 100, reasoningTokens: 77 },
      local: true,
    });
    expect(stats.reasoningTokens).toBe(77);
    expect(stats.derived).toBeUndefined();
  });

  it('never counts hosted frames as tokens: a hosted frame carries many', () => {
    const stats = buildReplyStats({
      endedAt: 3_000,
      rounds: [
        round({ startedAt: 0, firstReasoningAt: 300, lastReasoningAt: 2_300, endedAt: 3_000 }, { reasoningFrames: 9 }),
      ],
      toolMs: 0,
      usage: { outputTokens: 100 },
      local: false,
    });
    expect(stats.reasoningTokens).toBeUndefined();
  });

  it('folds a continued run onto the earlier one, leaving out the pause before Continue', () => {
    const earlier: ChatReplyStats = {
      totalMs: 60_000,
      modelMs: 20_000,
      toolMs: 40_000,
      firstTokenMs: 500,
      reasoningMs: 3_000,
      reasoningTokens: 40,
      derived: ['reasoningTokens'],
    };
    const stats = buildReplyStats({
      endedAt: 510_000,
      rounds: [
        round(
          {
            startedAt: 500_100,
            firstTokenAt: 500_400,
            firstReasoningAt: 500_400,
            lastReasoningAt: 501_400,
            firstTextAt: 501_500,
            endedAt: 509_000,
          },
          { reasoningFrames: 10 }
        ),
      ],
      toolMs: 0,
      usage: { outputTokens: 500 },
      local: true,
      earlier,
    });
    expect(stats).toEqual({
      totalMs: 69_900,
      modelMs: 28_900,
      toolMs: 40_000,
      loadMs: 0,
      firstTokenMs: 500,
      reasoningMs: 4_000,
      reasoningTokens: 50,
      derived: ['reasoningTokens'],
    });
  });

  it('does not count a self-hosted cold start as thinking when one readable frame is all it sent', () => {
    const rounds = [
      round(
        {
          startedAt: 0,
          firstTokenAt: 6_000,
          firstReasoningAt: 6_000,
          lastReasoningAt: 6_000,
          firstTextAt: 6_100,
          endedAt: 7_000,
        },
        { reasoningFrames: 1 }
      ),
    ];
    const local = buildReplyStats({ endedAt: 7_000, rounds, toolMs: 0, usage: { outputTokens: 40 }, local: true });
    expect(local.reasoningMs).toBe(0);
    expect(local.derived).toEqual(['reasoningTokens']);
    expect(buildReplyStats({ endedAt: 7_000, rounds, toolMs: 0, local: false }).reasoningMs).toBe(6_100);
  });

  it('drops an earlier thinking-token estimate once the server reports a count', () => {
    const stats = buildReplyStats({
      endedAt: 2_000,
      rounds: [round({ startedAt: 0, firstTokenAt: 100, firstTextAt: 100, endedAt: 2_000 })],
      toolMs: 0,
      usage: { outputTokens: 500, reasoningTokens: 120 },
      local: true,
      earlier: { totalMs: 1_000, modelMs: 1_000, toolMs: 0, reasoningTokens: 40, derived: ['reasoningTokens'] },
    });
    expect(stats.reasoningTokens).toBe(120);
    expect(stats.derived).toBeUndefined();
  });

  it('adds a continued run to the earlier generation time, and keeps none when the earlier run had none kept', () => {
    const next = round({ startedAt: 50_000, firstTokenAt: 50_400, firstTextAt: 50_400, endedAt: 52_400 });
    const run = { endedAt: 52_400, rounds: [next], toolMs: 0, local: false };
    expect(
      buildReplyStats({ ...run, earlier: { totalMs: 5_000, modelMs: 5_000, toolMs: 0, outputMs: 3_000 } }).outputMs
    ).toBe(5_000);
    expect(
      buildReplyStats({ ...run, earlier: { totalMs: 5_000, modelMs: 5_000, toolMs: 0 } }).outputMs
    ).toBeUndefined();
    expect(buildReplyStats({ ...run, earlier: { totalMs: 0, modelMs: 0, toolMs: 0 } }).outputMs).toBe(2_000);
  });
});

describe('roundLoad', () => {
  const timed = (rate: NonNullable<StatsRound['usage']>['rate'], endedAt = 31_300) =>
    round({ startedAt: 0, firstTokenAt: 28_600, endedAt }, { usage: { outputTokens: 40, rate } });

  it("takes Ollama's reported load as it is, warm or cold", () => {
    expect(roundLoad(timed({ evalTokens: 40, evalMs: 2_600, promptMs: 500, loadMs: 28_000 }))).toEqual({
      ms: 28_000,
      derived: false,
    });
    expect(roundLoad(timed({ evalTokens: 40, evalMs: 2_600, loadMs: 40 }, 3_200))).toEqual({ ms: 40, derived: false });
  });

  it("derives llama-server's from the request's time outside its prompt and generation timings", () => {
    const llama = { evalTokens: 40, evalMs: 2_600, loadReported: false };
    expect(roundLoad(timed({ ...llama, promptMs: 500 }))).toEqual({ ms: 28_200, derived: true });
    expect(roundLoad(timed(llama))).toEqual({ ms: 28_700, derived: true });
    expect(roundLoad(timed({ ...llama, promptMs: 500 }, 3_200))).toEqual({ ms: 100, derived: true });
    expect(roundLoad(timed({ ...llama, promptMs: 500 }, 3_100))).toBeNull();
  });

  it('derives no wait for a server that reports its load, or for timings that do not say', () => {
    // Ollama leaves out a zero load_duration: its wall time beyond the timings is no load.
    expect(roundLoad(timed({ evalTokens: 40, evalMs: 2_600, promptMs: 500, loadReported: true }))).toBeNull();
    expect(roundLoad(timed({ evalTokens: 40, evalMs: 2_600, promptMs: 500 }))).toBeNull();
  });

  it('names no load for a stream this app timed, or a round no server timed', () => {
    expect(roundLoad(timed({ evalTokens: 39, evalMs: 2_600, estimated: true }))).toBeNull();
    expect(roundLoad(timed({ evalTokens: 40, evalMs: Number.NaN, loadMs: 28_000 }))).toBeNull();
    expect(roundLoad(round({ startedAt: 0, firstTokenAt: 28_600, endedAt: 31_300 }))).toBeNull();
  });
});

describe('a cold-loaded self-hosted reply', () => {
  const coldRound = (rate: NonNullable<StatsRound['usage']>['rate']) =>
    round(
      {
        startedAt: 0,
        firstTokenAt: 28_600,
        firstReasoningAt: 28_600,
        lastReasoningAt: 29_900,
        firstTextAt: 30_000,
        endedAt: 31_300,
      },
      { reasoningFrames: 30, reasoning: 'Short.', usage: { outputTokens: 40, rate } }
    );
  const build = (rate: NonNullable<StatsRound['usage']>['rate']) =>
    buildReplyStats({
      endedAt: 31_300,
      rounds: [coldRound(rate)],
      toolMs: 0,
      usage: { outputTokens: 40, rate },
      local: true,
    });

  it("keeps Ollama's load apart from the generation the thinking share is measured against", () => {
    expect(build({ evalTokens: 40, evalMs: 2_600, promptTokens: 900, promptMs: 500, loadMs: 28_000 })).toEqual({
      totalMs: 31_300,
      modelMs: 31_300,
      toolMs: 0,
      loadMs: 28_000,
      outputMs: 2_700,
      firstTokenMs: 28_600,
      firstTokenLoadMs: 28_000,
      reasoningMs: 1_300,
      reasoningTokens: 30,
      derived: ['reasoningTokens'],
    });
  });

  it("marks the load it worked out from llama-server's timings", () => {
    expect(
      build({ evalTokens: 40, evalMs: 2_600, promptTokens: 900, promptMs: 500, loadReported: false })
    ).toMatchObject({
      loadMs: 28_200,
      outputMs: 2_700,
      derived: ['loadMs', 'reasoningTokens'],
    });
  });

  it('leaves the load and prompt time out of a thinking time estimated from the wait', () => {
    const stats = buildReplyStats({
      endedAt: 31_000,
      rounds: [
        round(
          { startedAt: 0, firstTokenAt: 30_000, firstTextAt: 30_000, endedAt: 31_000 },
          {
            usage: {
              outputTokens: 40,
              reasoningTokens: 20,
              rate: { evalTokens: 40, evalMs: 900, promptMs: 500, loadMs: 28_000 },
            },
          }
        ),
      ],
      toolMs: 0,
      usage: { outputTokens: 40, reasoningTokens: 20 },
      local: true,
    });
    expect(stats).toMatchObject({ reasoningMs: 1_500, loadMs: 28_000, derived: ['reasoningMs'] });
  });
});

describe('the load of a reply of several requests', () => {
  type Rate = NonNullable<StatsRound['usage']>['rate'];
  // Each request takes `wallMs`, of which llama-server timed 100ms of prompt and 2s of generation.
  const request = (startedAt: number, wallMs: number, rate: Partial<NonNullable<Rate>> = {}): StatsRound => {
    const endedAt = startedAt + wallMs;
    const timings = { evalTokens: 40, evalMs: 2_000, promptMs: 100, loadReported: false, ...rate };
    return round(
      { startedAt, firstTokenAt: endedAt - 2_000, firstTextAt: endedAt - 2_000, endedAt },
      { usage: { outputTokens: 40, rate: timings } }
    );
  };
  const ollama = (startedAt: number, wallMs: number, loadMs?: number) =>
    request(startedAt, wallMs, { loadReported: true, ...(loadMs !== undefined ? { loadMs } : {}) });
  const build = (rounds: StatsRound[], extra: Partial<Parameters<typeof buildReplyStats>[0]> = {}) =>
    buildReplyStats({ endedAt: rounds.at(-1)?.timing.endedAt ?? 0, rounds, toolMs: 0, local: true, ...extra });

  it('counts no wait for warm requests, however many add up', () => {
    const warm = Array.from({ length: 8 }, (_, i) => request(i * 5_000, 3_000));
    const stats = build(warm);
    expect(stats.loadMs).toBeUndefined();
    expect(stats.firstTokenLoadMs).toBeUndefined();
    expect(stats.derived).toBeUndefined();
    const warmOllama = Array.from({ length: 8 }, (_, i) => ollama(i * 5_000, 3_000, 800));
    expect(build(warmOllama).loadMs).toBeUndefined();
  });

  it('counts a cold request among warm ones, and times the first token against its own', () => {
    const rounds = [request(0, 30_000), ...Array.from({ length: 4 }, (_, i) => request(40_000 + i * 5_000, 3_000))];
    expect(build(rounds)).toMatchObject({ loadMs: 27_900, firstTokenLoadMs: 27_900, derived: ['loadMs'] });
    const reloaded = [ollama(0, 30_000, 27_000), ollama(40_000, 13_000, 10_000)];
    expect(build(reloaded)).toMatchObject({ loadMs: 37_000, firstTokenLoadMs: 27_000 });
    const lateLoad = [ollama(0, 3_000), ollama(10_000, 13_000, 10_000)];
    expect(build(lateLoad)).toMatchObject({ loadMs: 10_000 });
    expect(build(lateLoad).firstTokenLoadMs).toBeUndefined();
    expect(build(lateLoad).derived).toBeUndefined();
  });

  it('carries a continued reply load from the earlier run, or from its reported rate where none was stored', () => {
    const next = [ollama(100_000, 3_000, 40)];
    const kept = { totalMs: 34_000, modelMs: 34_000, toolMs: 0, outputMs: 3_000 };
    const loaded = { ...kept, loadMs: 28_000, firstTokenMs: 29_000, firstTokenLoadMs: 28_000 };
    expect(build(next, { earlier: loaded })).toMatchObject({ loadMs: 28_000, firstTokenLoadMs: 28_000 });
    expect(build(next, { earlier: kept }).loadMs).toBeUndefined();
    const before = { totalMs: 34_000, modelMs: 34_000, toolMs: 0 };
    const usage = { outputTokens: 80, rate: { evalTokens: 80, evalMs: 4_000, loadMs: 28_040, loadReported: true } };
    expect(build(next, { earlier: before, usage })).toMatchObject({ loadMs: 28_000 });
    expect(build(next, { earlier: before, usage }).loadPartial).toBeUndefined();
    // Stored before the stamp: a reported load still reads as one.
    const { loadReported: _, ...unstamped } = usage.rate;
    expect(build(next, { earlier: before, usage: { ...usage, rate: unstamped } }).loadMs).toBe(28_000);
  });

  it("holds an earlier run's summed load to the per-request rule, as unknown where it ran tools", () => {
    const next = [ollama(100_000, 3_000, 40)];
    const rate = (loadMs: number) => ({ outputTokens: 80, rate: { evalTokens: 80, evalMs: 4_000, loadMs } });
    const noTools = { totalMs: 34_000, modelMs: 34_000, toolMs: 0 };
    const tools = { ...noTools, toolMs: 5_000 };
    // Thirty warm requests at 50ms: no one of them reached the rule's second.
    expect(build(next, { earlier: tools, usage: rate(1_540) })).toMatchObject({ loadPartial: true });
    expect(build(next, { earlier: tools, usage: rate(1_540) }).loadMs).toBe(0);
    expect(build(next, { earlier: tools, usage: rate(940) }).loadPartial).toBeUndefined();
    expect(build(next, { earlier: noTools, usage: rate(940) }).loadMs).toBe(0);
    // One cold request: the whole sum is its load.
    expect(build(next, { earlier: noTools, usage: rate(28_040) })).toMatchObject({ loadMs: 28_000 });
  });

  it("keeps this run's wait when an earlier run timed by llama-server was stored without its own", () => {
    const next = [request(100_000, 30_000)];
    const usage = { outputTokens: 80, rate: { evalTokens: 80, evalMs: 4_000, promptMs: 200, loadReported: false } };
    const earlier = { totalMs: 34_000, modelMs: 34_000, toolMs: 0 };
    const stats = build(next, { earlier, usage });
    expect(stats).toMatchObject({ loadMs: 27_900, loadPartial: true, derived: ['loadMs'] });
    expect(build([request(100_000, 3_000)], { earlier, usage })).toMatchObject({ loadPartial: true });
    expect(build([request(100_000, 3_000)], { earlier, usage }).loadMs).toBe(0);
    const { loadReported: _, ...unstamped } = usage.rate;
    expect(build(next, { earlier, usage: { ...usage, rate: unstamped } })).toMatchObject({ loadPartial: true });
    expect(build(next, { earlier, usage: { outputTokens: 80 } })).toMatchObject({ loadMs: 27_900 });
    expect(build(next, { earlier, usage: { outputTokens: 80 } }).loadPartial).toBeUndefined();
    // Carried to a further Continue.
    expect(build([request(200_000, 3_000)], { earlier: stats, usage })).toMatchObject({
      loadMs: 27_900,
      loadPartial: true,
    });
  });

  it('knows an earlier Ollama run stored without its load had none where the server reported none', () => {
    const next = [ollama(100_000, 3_000)];
    const earlier = { totalMs: 34_000, modelMs: 34_000, toolMs: 0 };
    const usage = { outputTokens: 80, rate: { evalTokens: 80, evalMs: 4_000, loadReported: true } };
    const stats = build(next, { earlier, usage });
    expect(stats.loadMs).toBe(0);
    expect(stats.loadPartial).toBeUndefined();
  });

  it('stores a zero load on a Continue of a reply stored without one, so it never reads as stored before loads', () => {
    // Two warm requests, 700ms and 500ms: neither counted, though their sum passes the rule's second.
    const next = [ollama(100_000, 3_000, 500)];
    const earlier = { totalMs: 34_000, modelMs: 34_000, toolMs: 0 };
    const usage = { outputTokens: 80, rate: { evalTokens: 80, evalMs: 4_000, loadMs: 1_200, loadReported: true } };
    const stats = build(next, { earlier, usage });
    expect(stats.outputMs).toBeUndefined();
    expect(stats.loadMs).toBe(0);
    expect(build([ollama(200_000, 3_000, 500)], { earlier: stats, usage }).loadMs).toBe(0);
  });
});
