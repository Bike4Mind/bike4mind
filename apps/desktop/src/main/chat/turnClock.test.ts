import { describe, expect, it } from 'vitest';
import { DEFAULT_TURN_EXTENSIONS, parseTurnExtensions } from '@shared/turnExtensionSetting';
import { canExtendTurn, TurnClock } from './turnClock';

function fakeNow(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('TurnClock', () => {
  it('counts nothing as idle until paused', () => {
    const time = fakeNow();
    const clock = new TurnClock(time.now);
    time.advance(500);
    expect(clock.idleMs()).toBe(0);
  });

  it('excludes the time between a pause and its resume, including one still open', () => {
    const time = fakeNow();
    const clock = new TurnClock(time.now);
    const resume = clock.pause();
    time.advance(300);
    expect(clock.idleMs()).toBe(300);
    time.advance(200);
    resume();
    time.advance(1_000);
    expect(clock.idleMs()).toBe(500);
  });

  it('counts overlapping pauses once, from the first pause to the last resume', () => {
    const time = fakeNow();
    const clock = new TurnClock(time.now);
    const first = clock.pause();
    time.advance(100);
    const second = clock.pause();
    time.advance(100);
    first();
    time.advance(100);
    second();
    time.advance(100);
    expect(clock.idleMs()).toBe(300);
  });

  it('ignores a second resume of the same pause', () => {
    const time = fakeNow();
    const clock = new TurnClock(time.now);
    const outer = clock.pause();
    const inner = clock.pause();
    time.advance(100);
    inner();
    inner();
    time.advance(100);
    // Still paused by `outer`: the repeated resume must not have closed it.
    expect(clock.idleMs()).toBe(200);
    outer();
  });
});

describe('canExtendTurn', () => {
  it('extends a productive turn while under the cap', () => {
    expect(canExtendTurn({ extensions: 0, allowed: 3, stalled: 0 })).toBe(true);
    expect(canExtendTurn({ extensions: 2, allowed: 3, stalled: 1 })).toBe(true);
  });

  it('stops once the cap is spent, and always when the setting is 0', () => {
    expect(canExtendTurn({ extensions: 3, allowed: 3, stalled: 0 })).toBe(false);
    expect(canExtendTurn({ extensions: 0, allowed: 0, stalled: 0 })).toBe(false);
  });

  it('never extends a turn that has started repeating itself', () => {
    expect(canExtendTurn({ extensions: 0, allowed: 3, stalled: 2 })).toBe(false);
  });
});

describe('parseTurnExtensions', () => {
  it('keeps a whole number in range, including 0', () => {
    expect(parseTurnExtensions(0)).toBe(0);
    expect(parseTurnExtensions(5)).toBe(5);
  });

  it('reads anything else as the default', () => {
    for (const value of [undefined, null, -1, 11, 2.5, '3', Number.NaN]) {
      expect(parseTurnExtensions(value)).toBe(DEFAULT_TURN_EXTENSIONS);
    }
  });
});
