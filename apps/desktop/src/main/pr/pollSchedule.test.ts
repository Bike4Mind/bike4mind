import { describe, expect, it } from 'vitest';
import { POLL_MS, pollDelay, type PollInput } from './pollSchedule';

const base: PollInput = {
  state: 'OPEN',
  dismissed: false,
  onScreen: true,
  opened: true,
  armed: false,
  active: true,
  failures: 0,
};

describe('pollDelay', () => {
  it('reads the PR on screen often while checks run, less once settled', () => {
    expect(pollDelay(base)).toBe(POLL_MS.onScreenActive);
    expect(pollDelay({ ...base, active: false })).toBe(POLL_MS.onScreenSettled);
  });

  it('reads a conversation opened earlier much less often', () => {
    expect(pollDelay({ ...base, onScreen: false })).toBe(POLL_MS.openedActive);
    expect(pollDelay({ ...base, onScreen: false, active: false })).toBe(POLL_MS.openedSettled);
  });

  it('never reads an unopened conversation unless something is armed on it', () => {
    expect(pollDelay({ ...base, onScreen: false, opened: false })).toBeNull();
    expect(pollDelay({ ...base, onScreen: false, opened: false, armed: true })).toBe(POLL_MS.unopenedArmed);
  });

  it('stops entirely once the PR is merged or closed, whatever else is true', () => {
    expect(pollDelay({ ...base, state: 'MERGED', armed: true })).toBeNull();
    expect(pollDelay({ ...base, state: 'CLOSED', armed: true })).toBeNull();
  });

  it('stops for a dismissed bar with nothing armed', () => {
    expect(pollDelay({ ...base, dismissed: true })).toBeNull();
  });

  it('backs off exponentially on failures, from a floor, up to a cap', () => {
    expect(pollDelay({ ...base, failures: 1 })).toBe(POLL_MS.backoffFloor * 2);
    expect(pollDelay({ ...base, failures: 2 })).toBe(POLL_MS.backoffFloor * 4);
    expect(pollDelay({ ...base, failures: 50 })).toBe(POLL_MS.maxBackoff);
    expect(pollDelay({ ...base, onScreen: false, active: false, failures: 1 })).toBe(POLL_MS.openedSettled * 2);
  });
});
