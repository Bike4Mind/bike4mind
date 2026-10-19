import { describe, expect, it, vi } from 'vitest';
import {
  claimLiveDispatch,
  dispatchUiSideEffects,
  noteReplyInFlight,
  registerUiSideEffectHandler,
} from './uiSideEffectDispatcher';

describe('live dispatch ledger', () => {
  it('grants the live claim once, for a reply seen in flight', () => {
    noteReplyInFlight('ledger-a');
    expect(claimLiveDispatch('ledger-a')).toBe(true);
    expect(claimLiveDispatch('ledger-a')).toBe(false);
  });

  it('never grants a live claim for a reply not seen in flight (reload / session load)', () => {
    expect(claimLiveDispatch('ledger-b')).toBe(false);
  });

  it('does not re-arm a claimed reply that is seen in flight again (stale refetch)', () => {
    noteReplyInFlight('ledger-c');
    expect(claimLiveDispatch('ledger-c')).toBe(true);
    noteReplyInFlight('ledger-c');
    expect(claimLiveDispatch('ledger-c')).toBe(false);
  });
});

describe('dispatchUiSideEffects', () => {
  it('passes options through to every registered handler and sums their counts', () => {
    const a = vi.fn(() => 1);
    const b = vi.fn(() => 2);
    const offA = registerUiSideEffectHandler(a);
    const offB = registerUiSideEffectHandler(b);
    const effects = [{ type: 't', payload: {} }];
    expect(dispatchUiSideEffects(effects, { live: true, dedupeKey: 'k' })).toBe(3);
    expect(a).toHaveBeenCalledWith(effects, { live: true, dedupeKey: 'k' });
    offA();
    offB();
  });
});
