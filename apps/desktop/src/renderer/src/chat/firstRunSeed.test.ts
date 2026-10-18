import { describe, expect, it } from 'vitest';
import { seedOnArrival } from './firstRunSeed';

const arrival = (hasSessionInMode: boolean, mode: 'chat' | 'code' = 'chat') => ({
  loading: false,
  mode,
  hasSessionInMode,
});

describe('seeding a mode on first arrival', () => {
  it('makes the first session when the mode is empty', () => {
    expect(seedOnArrival(new Set(), arrival(false))).toBe(true);
  });

  it('makes nothing when the mode already has one', () => {
    expect(seedOnArrival(new Set(), arrival(true))).toBe(false);
  });

  // The list is not read until it has been read, or every window would seed over the top of
  // sessions that are about to arrive.
  it('waits for the session list', () => {
    const arrived = new Set<'chat' | 'code'>();
    expect(seedOnArrival(arrived, { loading: true, mode: 'chat', hasSessionInMode: false })).toBe(false);
    expect(arrived.size).toBe(0);
  });

  // The created session re-renders the shell straight back into this call.
  it('answers once per mode, so a create cannot feed itself', () => {
    const arrived = new Set<'chat' | 'code'>();
    expect(seedOnArrival(arrived, arrival(false))).toBe(true);
    expect(seedOnArrival(arrived, arrival(false))).toBe(false);
  });

  // A failed create leaves the mode as empty as it found it, which is the shape that retries
  // forever if arrival is not what is marked.
  it('does not retry a create that failed', () => {
    const arrived = new Set<'chat' | 'code'>();
    seedOnArrival(arrived, arrival(false));
    expect(seedOnArrival(arrived, arrival(false))).toBe(false);
  });

  it('seeds each mode once, so toggling Chat/Code piles nothing up', () => {
    const arrived = new Set<'chat' | 'code'>();
    expect(seedOnArrival(arrived, arrival(false, 'chat'))).toBe(true);
    expect(seedOnArrival(arrived, arrival(false, 'code'))).toBe(true);
    expect(seedOnArrival(arrived, arrival(false, 'chat'))).toBe(false);
    expect(seedOnArrival(arrived, arrival(false, 'code'))).toBe(false);
  });

  // Deleting the last one has to look like it worked.
  it('leaves a mode emptied by a delete empty', () => {
    const arrived = new Set<'chat' | 'code'>();
    expect(seedOnArrival(arrived, arrival(true))).toBe(false);
    expect(seedOnArrival(arrived, arrival(false))).toBe(false);
  });
});
