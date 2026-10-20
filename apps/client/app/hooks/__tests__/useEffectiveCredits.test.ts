import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { renderHook, act } from '@testing-library/react';
import { POST_STREAM_HOLD_MAX_MS, useCreditSyncSignal, useEffectiveCredits } from '../useEffectiveCredits';
import { useStreamingState } from '../useStreamingState';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';

const mockUseUser = vi.fn();

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => mockUseUser(),
}));

describe('useEffectiveCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStreamingState.setState({ sessions: new Map() });
    useSelectedAccount.setState({ selectedAccount: null });
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1500 } });
  });

  it('returns the live balance while idle', () => {
    const { result } = renderHook(() => useEffectiveCredits());
    expect(result.current).toBe(1500);
  });

  it('holds the pre-turn balance while streaming, then settles once on completion', () => {
    const { result, rerender } = renderHook(() => useEffectiveCredits());
    expect(result.current).toBe(1500);

    // Streaming starts - the freeze snapshots the balance while it's still live.
    act(() => useStreamingState.getState().startStreaming('session-1'));
    expect(result.current).toBe(1500);

    // Reserve lands mid-turn: worst-case dip, hidden behind the freeze.
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 227 } });
    rerender();
    expect(result.current).toBe(1500);

    // Turn completes and reconcile settles the balance - one update, not a bounce.
    act(() => useStreamingState.getState().completeStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1327 } });
    rerender();
    expect(result.current).toBe(1327);
  });

  it('releases the freeze on reset/abort (session removed from the map)', () => {
    const { result, rerender } = renderHook(() => useEffectiveCredits());

    act(() => useStreamingState.getState().startStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 227 } });
    rerender();
    expect(result.current).toBe(1500);

    act(() => useStreamingState.getState().resetStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1400 } });
    rerender();
    expect(result.current).toBe(1400);
  });

  // The error/cancel paths (`useSubscribeChatCompletion`) do NOT delete the
  // session - they leave the entry in the map with status 'error'/'cancelled'.
  // Release therefore relies on `isAnyStreaming()` filtering on 'streaming'
  // only; assert the freeze still lifts with the terminal entry still present.
  it('releases the freeze on error, even though the errored session lingers in the map', () => {
    const { result, rerender } = renderHook(() => useEffectiveCredits());

    act(() => useStreamingState.getState().startStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 227 } });
    rerender();
    expect(result.current).toBe(1500);

    act(() => useStreamingState.getState().errorStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1400 } });
    rerender();
    expect(result.current).toBe(1400); // released despite the 'error' entry still in the map
    expect(useStreamingState.getState().getStreamingStatus('session-1')).toBe('error');
  });

  it('releases the freeze on cancel, even though the cancelled session lingers in the map', () => {
    const { result, rerender } = renderHook(() => useEffectiveCredits());

    act(() => useStreamingState.getState().startStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 227 } });
    rerender();
    expect(result.current).toBe(1500);

    act(() => useStreamingState.getState().cancelStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1400 } });
    rerender();
    expect(result.current).toBe(1400); // released despite the 'cancelled' entry still in the map
    expect(useStreamingState.getState().getStreamingStatus('session-1')).toBe('cancelled');
  });

  it('stays frozen until the last of several concurrent sessions finishes', () => {
    const { result, rerender } = renderHook(() => useEffectiveCredits());

    act(() => {
      useStreamingState.getState().startStreaming('session-1');
      useStreamingState.getState().startStreaming('session-2');
    });
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 200 } });
    rerender();
    expect(result.current).toBe(1500);

    act(() => useStreamingState.getState().completeStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 300 } });
    rerender();
    expect(result.current).toBe(1500);

    act(() => useStreamingState.getState().completeStreaming('session-2'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1350 } });
    rerender();
    expect(result.current).toBe(1350);
  });

  describe('after the turn ends, before the settled balance arrives', () => {
    const endTurnWithHoldDippedBalance = () => {
      const view = renderHook(() => useEffectiveCredits());
      act(() => useStreamingState.getState().startStreaming('session-1'));
      mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 227 } });
      view.rerender();
      act(() => useStreamingState.getState().completeStreaming('session-1'));
      return view;
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the pre-turn balance instead of showing the hold-dipped one', () => {
      const { result } = endTurnWithHoldDippedBalance();
      expect(result.current).toBe(1500);
    });

    it('goes straight from the pre-turn balance to the settled one with no hold-based value ever committed', () => {
      const committed: number[] = [];
      const { rerender } = renderHook(() => {
        const credits = useEffectiveCredits();
        useEffect(() => {
          committed.push(credits);
        });
        return credits;
      });
      act(() => useStreamingState.getState().startStreaming('session-1'));
      mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 227 } });
      rerender();
      act(() => useStreamingState.getState().completeStreaming('session-1'));
      mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1421 } });
      rerender();

      expect(committed).not.toContain(227);
      expect([...new Set(committed)]).toEqual([1500, 1421]);
    });

    it('still holds the pre-turn balance when the settled balance arrived before streaming ended, until the sync confirms', () => {
      const { result, rerender } = renderHook(() => useEffectiveCredits());
      act(() => useStreamingState.getState().startStreaming('session-1'));
      mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 1421 } });
      rerender();
      act(() => useStreamingState.getState().completeStreaming('session-1'));
      expect(result.current).toBe(1500);

      act(() => useCreditSyncSignal.getState().markSynced());
      expect(result.current).toBe(1421);
    });

    it('keeps the hold per hook instance: a chip mounted mid-hold shows the live balance', () => {
      const first = endTurnWithHoldDippedBalance();
      expect(first.result.current).toBe(1500);

      const mountedMidHold = renderHook(() => useEffectiveCredits());
      expect(mountedMidHold.result.current).toBe(227);

      act(() => useCreditSyncSignal.getState().markSynced());
      expect(first.result.current).toBe(227);
    });

    it('releases to the live balance when the post-turn balance sync completes with no change', () => {
      const { result } = endTurnWithHoldDippedBalance();
      expect(result.current).toBe(1500);

      act(() => useCreditSyncSignal.getState().markSynced());
      expect(result.current).toBe(227);
    });

    it('releases to the live balance after the backstop even if no sync ever lands', () => {
      vi.useFakeTimers();
      const { result } = endTurnWithHoldDippedBalance();
      expect(result.current).toBe(1500);

      act(() => {
        vi.advanceTimersByTime(POST_STREAM_HOLD_MAX_MS);
      });
      expect(result.current).toBe(227);
    });

    it('keeps holding the first turn pre-turn balance when a new turn starts before the settled balance lands', () => {
      const { result, rerender } = endTurnWithHoldDippedBalance();

      act(() => useStreamingState.getState().startStreaming('session-2'));
      expect(result.current).toBe(1500);

      mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 100 } });
      rerender();
      expect(result.current).toBe(1500);
    });
  });

  it('reflects a genuine balance change once idle (freeze does not permanently pin the value)', () => {
    const { result, rerender } = renderHook(() => useEffectiveCredits());
    expect(result.current).toBe(1500);

    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 2500 } });
    rerender();
    expect(result.current).toBe(2500);
  });

  it('{ live: true } always reads the live balance, even mid-turn', () => {
    const { result, rerender } = renderHook(() => useEffectiveCredits({ live: true }));

    act(() => useStreamingState.getState().startStreaming('session-1'));
    mockUseUser.mockReturnValue({ currentUser: { id: 'user-1', currentCredits: 227 } });
    rerender();

    expect(result.current).toBe(227);
  });

  it('uses the org account balance when a non-personal account is selected', () => {
    useSelectedAccount.setState({
      selectedAccount: { id: 'org-1', name: 'Org', personal: false, credits: 9000 },
    });
    const { result } = renderHook(() => useEffectiveCredits());
    expect(result.current).toBe(9000);
  });
});
