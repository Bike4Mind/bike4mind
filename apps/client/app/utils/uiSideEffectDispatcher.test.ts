import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimLiveDispatch,
  claimReplayDispatch,
  dispatchUiSideEffects,
  forgetSessionDispatches,
  noteReplyInFlight,
  registerUiSideEffectHandler,
  settleReplyInFlight,
} from './uiSideEffectDispatcher';

// The ledger is module state shared by every test in this file, so keys and sessions are
// unique per test (a release cannot leak into another test's claims).
describe('live dispatch ledger', () => {
  it('grants the live claim once, for a reply seen in flight', () => {
    noteReplyInFlight('ledger-a', 'session-a');
    expect(claimLiveDispatch('ledger-a')).toBe(true);
    expect(claimLiveDispatch('ledger-a')).toBe(false);
  });

  it('never grants a live claim for a reply not seen in flight (reload / session load)', () => {
    expect(claimLiveDispatch('ledger-b')).toBe(false);
  });

  it('does not re-arm a claimed reply that is seen in flight again (stale refetch)', () => {
    noteReplyInFlight('ledger-c', 'session-c');
    expect(claimLiveDispatch('ledger-c')).toBe(true);
    noteReplyInFlight('ledger-c', 'session-c');
    expect(claimLiveDispatch('ledger-c')).toBe(false);
  });

  it('grants a replay once per reply until its session is released', () => {
    expect(claimReplayDispatch('ledger-d', 'session-d')).toBe(true);
    expect(claimReplayDispatch('ledger-d', 'session-d')).toBe(false);
    forgetSessionDispatches('session-other');
    expect(claimReplayDispatch('ledger-d', 'session-d')).toBe(false);
    forgetSessionDispatches('session-d');
    expect(claimReplayDispatch('ledger-d', 'session-d')).toBe(true);
  });

  it('refuses a replay while the reply is in flight, and after it went live', () => {
    noteReplyInFlight('ledger-e', 'session-e');
    expect(claimReplayDispatch('ledger-e', 'session-e')).toBe(false);
    expect(claimLiveDispatch('ledger-e', 'session-e')).toBe(true);
    expect(claimReplayDispatch('ledger-e', 'session-e')).toBe(false);
    forgetSessionDispatches('session-e');
    expect(claimLiveDispatch('ledger-e', 'session-e')).toBe(false);
    expect(claimReplayDispatch('ledger-e', 'session-e')).toBe(true);
  });

  it('turns a reply that finished while its session was left into a replay', () => {
    noteReplyInFlight('ledger-f', 'session-f');
    forgetSessionDispatches('session-f');
    expect(claimLiveDispatch('ledger-f', 'session-f')).toBe(false);
    expect(claimReplayDispatch('ledger-f', 'session-f')).toBe(true);
  });

  it('re-notes a reply that is still streaming when its session view is re-entered', () => {
    noteReplyInFlight('ledger-g', 'session-g');
    forgetSessionDispatches('session-g');
    noteReplyInFlight('ledger-g', 'session-g');
    expect(claimLiveDispatch('ledger-g', 'session-g')).toBe(true);
  });

  it('settles an in-flight reply that finishes with no effects', () => {
    noteReplyInFlight('ledger-h', 'session-h');
    settleReplyInFlight('ledger-h');
    expect(claimLiveDispatch('ledger-h', 'session-h')).toBe(false);
    expect(claimReplayDispatch('ledger-h', 'session-h')).toBe(true);
  });
});

describe('dispatchUiSideEffects', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes options through to every registered handler and sums their counts', () => {
    const a = vi.fn(() => 1);
    const b = vi.fn(() => 2);
    const offA = registerUiSideEffectHandler(a);
    const offB = registerUiSideEffectHandler(b);
    try {
      const effects = [{ type: 't', payload: {} }];
      expect(dispatchUiSideEffects(effects, { live: true, dedupeKey: 'k' })).toBe(3);
      expect(a).toHaveBeenCalledWith(effects, { live: true, dedupeKey: 'k' });
    } finally {
      offA();
      offB();
    }
  });
});
