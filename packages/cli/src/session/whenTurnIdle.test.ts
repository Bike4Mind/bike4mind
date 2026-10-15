import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCliStore } from '../store/index.js';
import { whenTurnIdle } from './whenTurnIdle';

describe('whenTurnIdle', () => {
  beforeEach(() => {
    useCliStore.setState({ sessionHolds: 0, isThinking: false });
  });

  it('runs at once when nothing holds the session', () => {
    const callback = vi.fn();
    whenTurnIdle(callback);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs as the last hold is released, not before', () => {
    const callback = vi.fn();
    const releaseTurn = useCliStore.getState().holdSession();
    const releaseCompaction = useCliStore.getState().holdSession();
    whenTurnIdle(callback);

    releaseCompaction();
    expect(callback).not.toHaveBeenCalled();
    releaseTurn();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ignores isThinking, which ESC clears before the turn has unwound', () => {
    const callback = vi.fn();
    const release = useCliStore.getState().holdSession();
    useCliStore.getState().setIsThinking(true);
    whenTurnIdle(callback);

    useCliStore.getState().setIsThinking(false);
    expect(callback).not.toHaveBeenCalled();
    release();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('treats a repeated release as a no-op', () => {
    const releaseFirst = useCliStore.getState().holdSession();
    const releaseSecond = useCliStore.getState().holdSession();
    releaseFirst();
    releaseFirst();

    expect(useCliStore.getState().sessionHolds).toBe(1);
    releaseSecond();
    expect(useCliStore.getState().sessionHolds).toBe(0);
  });
});
