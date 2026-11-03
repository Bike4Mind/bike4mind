import { describe, expect, it } from 'vitest';
import type { ChatReplyStats } from '@shared/chat';
import { buildReplyStats, roundThinking, type StatsRound } from './replyStats';

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

  it('reports nothing for a round that did not think', () => {
    expect(roundThinking(round({ startedAt: 0, firstTokenAt: 100, firstTextAt: 100, endedAt: 900 }))).toBeNull();
    expect(
      roundThinking(round({ startedAt: 0, firstTokenAt: 100, endedAt: 900 }, { usage: { reasoningTokens: 0 } }))
    ).toBeNull();
  });
});

describe('buildReplyStats', () => {
  it('times a plain hosted reply that did not think', () => {
    expect(
      buildReplyStats({
        startedAt: 1_000,
        endedAt: 4_000,
        rounds: [round({ startedAt: 1_100, firstTokenAt: 1_600, firstTextAt: 1_600, endedAt: 3_900 })],
        toolMs: 0,
        usage: { inputTokens: 10, outputTokens: 200 },
        local: false,
      })
    ).toEqual({
      startedAt: 1_000,
      firstTokenAt: 1_600,
      firstTextAt: 1_600,
      endedAt: 4_000,
      totalMs: 3_000,
      modelMs: 2_800,
      streamMs: 2_300,
      toolMs: 0,
    });
  });

  it('sums a tool reply over its rounds and keeps the first token and text from the first that had them', () => {
    const stats = buildReplyStats({
      startedAt: 0,
      endedAt: 10_000,
      rounds: [
        round(
          { startedAt: 100, firstTokenAt: 500, firstReasoningAt: 500, lastReasoningAt: 1_500, endedAt: 2_000 },
          { reasoning: 'look first' }
        ),
        round({ startedAt: 6_000, firstTokenAt: 6_500, firstTextAt: 6_500, endedAt: 9_900 }),
      ],
      toolMs: 4_000,
      usage: { outputTokens: 300, reasoningTokens: 120 },
      local: false,
    });
    expect(stats).toMatchObject({
      firstTokenAt: 500,
      firstTextAt: 6_500,
      totalMs: 10_000,
      modelMs: 5_800,
      streamMs: 4_900,
      toolMs: 4_000,
      reasoningMs: 1_000,
      reasoningTokens: 120,
    });
    expect(stats.derived).toBeUndefined();
  });

  it('takes the server thinking count as exact and marks an estimated thinking time', () => {
    const stats = buildReplyStats({
      startedAt: 0,
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
    expect(
      buildReplyStats({ startedAt: 0, endedAt: 3_000, rounds, toolMs: 0, usage: { outputTokens: 100 }, local: true })
    ).toMatchObject({ reasoningMs: 2_000, reasoningFrames: 80, reasoningTokens: 80, derived: ['reasoningTokens'] });
    expect(
      buildReplyStats({ startedAt: 0, endedAt: 3_000, rounds, toolMs: 0, usage: { outputTokens: 50 }, local: true })
    ).toMatchObject({ reasoningTokens: 50 });
  });

  it('prefers a self-hosted server thinking count over the frames', () => {
    const stats = buildReplyStats({
      startedAt: 0,
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
      startedAt: 0,
      endedAt: 3_000,
      rounds: [
        round({ startedAt: 0, firstReasoningAt: 300, lastReasoningAt: 2_300, endedAt: 3_000 }, { reasoningFrames: 9 }),
      ],
      toolMs: 0,
      usage: { outputTokens: 100 },
      local: false,
    });
    expect(stats.reasoningTokens).toBeUndefined();
    expect(stats.reasoningFrames).toBe(9);
  });

  it('folds a continued run onto the earlier one, leaving out the pause before Continue', () => {
    const earlier: ChatReplyStats = {
      startedAt: 1_000,
      firstTokenAt: 1_500,
      firstTextAt: 2_000,
      endedAt: 61_000,
      totalMs: 60_000,
      modelMs: 20_000,
      streamMs: 15_000,
      toolMs: 40_000,
      reasoningMs: 3_000,
      reasoningFrames: 40,
      reasoningTokens: 40,
      derived: ['reasoningTokens'],
    };
    const stats = buildReplyStats({
      startedAt: 500_000,
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
      startedAt: 1_000,
      firstTokenAt: 1_500,
      firstTextAt: 2_000,
      endedAt: 510_000,
      totalMs: 70_000,
      modelMs: 28_900,
      streamMs: 23_600,
      toolMs: 40_000,
      reasoningMs: 4_000,
      reasoningFrames: 50,
      reasoningTokens: 50,
      derived: ['reasoningTokens'],
    });
  });
});
