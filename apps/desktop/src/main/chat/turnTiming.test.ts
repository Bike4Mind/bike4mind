import { describe, expect, it } from 'vitest';
import { createRoundProbe, startRoundTimer } from './turnTiming';

describe('startRoundTimer', () => {
  it('stamps the first token, the thinking span and the first text, counting readable thinking only', () => {
    let clock = 1_000;
    const timer = startRoundTimer(() => clock);
    clock = 1_200;
    timer.firstToken();
    timer.reasoning('');
    clock = 1_300;
    timer.reasoning('Let me');
    clock = 2_000;
    timer.reasoning('\n');
    clock = 4_000;
    timer.reasoning(' check.');
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

  it('keeps the span of bare markers, as around thinking a provider omitted', () => {
    let clock = 0;
    const timer = startRoundTimer(() => clock);
    clock = 100;
    timer.reasoning('');
    clock = 9_100;
    timer.reasoning('');
    expect(timer.end()).toMatchObject({ firstReasoningAt: 100, lastReasoningAt: 9_100 });
    expect(timer.reasoningFrames()).toBe(0);
  });

  it('drops a block that held only whitespace, markers included', () => {
    let clock = 0;
    const timer = startRoundTimer(() => clock);
    clock = 100;
    timer.reasoning('');
    clock = 105;
    timer.reasoning('\n\n');
    clock = 110;
    timer.reasoning('');
    clock = 120;
    timer.text();
    clock = 400;
    expect(timer.end()).toEqual({ startedAt: 0, firstTextAt: 120, endedAt: 400 });
    expect(timer.reasoningFrames()).toBe(0);
  });

  it('ends the span at the last real thinking when an empty block follows it', () => {
    let clock = 0;
    const timer = startRoundTimer(() => clock);
    for (const [at, text] of [
      [100, ''],
      [200, 'Checking the index.'],
      [900, ''],
    ] as const) {
      clock = at;
      timer.reasoning(text);
    }
    clock = 950;
    timer.text();
    for (const [at, text] of [
      [3_000, ''],
      [3_005, '\n\n'],
      [3_010, ''],
    ] as const) {
      clock = at;
      timer.reasoning(text);
    }
    clock = 3_020;
    timer.text();
    clock = 3_500;

    expect(timer.end()).toMatchObject({ firstReasoningAt: 100, lastReasoningAt: 900 });
    expect(timer.reasoningFrames()).toBe(1);
  });

  it('keeps markers around omitted thinking that follow an empty block', () => {
    let clock = 0;
    const timer = startRoundTimer(() => clock);
    for (const [at, text] of [
      [100, ''],
      [105, '\n\n'],
      [110, ''],
    ] as const) {
      clock = at;
      timer.reasoning(text);
    }
    clock = 120;
    timer.text();
    clock = 1_000;
    timer.reasoning('');
    clock = 4_000;
    timer.reasoning('');
    clock = 4_100;

    expect(timer.end()).toMatchObject({ firstReasoningAt: 1_000, lastReasoningAt: 4_000 });
  });

  const run = (frames: ReadonlyArray<readonly [number, string | null]>) => {
    let clock = 0;
    const timer = startRoundTimer(() => clock);
    for (const [at, text] of frames) {
      clock = at;
      if (text === null) timer.text();
      else timer.reasoning(text);
    }
    return timer.end();
  };

  it('takes whitespace inside readable thinking as part of it, so a closing marker after it still counts', () => {
    expect(
      run([
        [100, ''],
        [200, 'Okay'],
        [300, ' '],
        [900, ''],
        [950, null],
      ])
    ).toMatchObject({ firstReasoningAt: 100, lastReasoningAt: 900 });
  });

  it('closes an empty block once readable thinking follows it', () => {
    expect(
      run([
        [100, ''],
        [105, '\n'],
        [200, 'Okay'],
        [900, ''],
        [950, null],
      ])
    ).toMatchObject({ firstReasoningAt: 200, lastReasoningAt: 900 });
  });

  it('closes an empty block sent in one frame once text follows it', () => {
    // A hosted '<think>\n\n</think>' in one frame reaches the timer as its whitespace alone.
    expect(
      run([
        [100, '\n\n'],
        [120, null],
        [1_000, ''],
        [4_000, ''],
        [4_100, null],
      ])
    ).toMatchObject({ firstReasoningAt: 1_000, lastReasoningAt: 4_000 });
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
