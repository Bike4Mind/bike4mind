import { describe, expect, it } from 'vitest';
import { SettledTurnCounters } from './useSettledTurns';

describe('SettledTurnCounters', () => {
  it('records a session first seen without counting the turns it settled before', () => {
    const counters = new SettledTurnCounters();
    expect(counters.observe('local', { sessionId: 's1', status: 'done', settledTurns: 4 })).toBe(false);
  });

  it('counts a rise once, and not a repeat of the same counter', () => {
    const counters = new SettledTurnCounters();
    counters.observe('local', { sessionId: 's1', status: 'processing' });
    expect(counters.observe('local', { sessionId: 's1', status: 'done', settledTurns: 1 })).toBe(true);
    expect(counters.observe('local', { sessionId: 's1', status: 'done', settledTurns: 1 })).toBe(false);
  });

  it('counts a rise that skipped pushes, as a coalesced queued chain does', () => {
    const counters = new SettledTurnCounters();
    counters.observe('local', { sessionId: 's1', status: 'processing', settledTurns: 1 });
    expect(counters.observe('local', { sessionId: 's1', status: 'processing', settledTurns: 3 })).toBe(true);
  });

  it('starts again from a lower counter, which is a restarted host', () => {
    const counters = new SettledTurnCounters();
    counters.observe('local', { sessionId: 's1', status: 'done', settledTurns: 5 });
    expect(counters.observe('local', { sessionId: 's1', status: 'done', settledTurns: 1 })).toBe(false);
    expect(counters.observe('local', { sessionId: 's1', status: 'done', settledTurns: 2 })).toBe(true);
  });

  it('keeps the same session id on two hosts apart', () => {
    const counters = new SettledTurnCounters();
    counters.observe('local', { sessionId: 's1', status: 'done', settledTurns: 3 });
    expect(counters.observe('box', { sessionId: 's1', status: 'done', settledTurns: 4 })).toBe(false);
  });
});
