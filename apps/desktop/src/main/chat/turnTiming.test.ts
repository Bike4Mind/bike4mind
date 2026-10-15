import { describe, expect, it } from 'vitest';
import { createRoundProbe } from './turnTiming';

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
