import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEffectiveCredits } from '../useEffectiveCredits';
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

  it('releases the freeze on error and on abort/cancel, not just on normal completion', () => {
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
