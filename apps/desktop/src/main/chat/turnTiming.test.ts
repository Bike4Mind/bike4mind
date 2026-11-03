import { describe, expect, it } from 'vitest';
import { createRoundProbe, startRoundTimer } from './turnTiming';

describe('startRoundTimer', () => {
  it('stamps the first token, the thinking span and the first text, counting readable thinking only', () => {
    let clock = 1_000;
    const timer = startRoundTimer(() => clock);
    clock = 1_200;
    timer.firstToken();
    timer.reasoning(false);
    clock = 1_300;
    timer.reasoning(true);
    clock = 4_000;
    timer.reasoning(true);
    timer.firstToken();
    clock = 4_100;
    timer.text();
    clock = 4_600;
    timer.text();
    clock = 5_000;

    expect(timer.reasoningFrames()).toBe(2);
    expect(timer.end()).toEqual({
      startedAt: 1_000,
      firstTokenAt: 1_200,
      firstReasoningAt: 1_200,
      lastReasoningAt: 4_000,
      firstTextAt: 4_100,
      endedAt: 5_000,
    });
  });

  it('leaves the stamps out of a round that neither thought nor wrote', () => {
    let clock = 0;
    const timer = startRoundTimer(() => clock);
    clock = 50;
    timer.firstToken();
    clock = 90;
    expect(timer.end()).toEqual({ startedAt: 0, firstTokenAt: 50, endedAt: 90 });
    expect(timer.reasoningFrames()).toBe(0);
  });
});

describe('createRoundProbe', () => {
  it('measures from the request going out and reports the desktop work before it', () => {
    let clock = 400;
    const probe = createRoundProbe(0, () => clock);
    clock = 420;
    probe.frame('meta');
    clock = 2_400;
    probe.frame('marker');
    clock = 30_400;
    probe.frame('text');
    clock = 31_400;

    expect(probe.end()).toEqual({
      beforeSendMs: 400,
      firstFrameMs: 20,
      firstMetaMs: 20,
      firstMarkerMs: 2_000,
      firstTextMs: 30_000,
      endMs: 31_000,
      maxGapMs: 28_000,
      maxGapBefore: 'text',
      frames: 3,
    });
  });

  it('keeps the first of each kind and blames the end for a silent tail', () => {
    let clock = 0;
    const probe = createRoundProbe(undefined, () => clock);
    clock = 1_000;
    probe.frame('text');
    clock = 1_500;
    probe.frame('text');
    clock = 61_500;

    const phases = probe.end();
    expect(phases.beforeSendMs).toBeUndefined();
    expect(phases.firstTextMs).toBe(1_000);
    expect(phases).toMatchObject({ maxGapMs: 60_000, maxGapBefore: 'end' });
  });
});
