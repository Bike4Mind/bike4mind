import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiPost = vi.fn(() => Promise.resolve());
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}));

import { useStreamingMetrics } from '../useStreamingMetrics';

describe('useStreamingMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  describe('chunk counting', () => {
    it('reports the first chunk as first, subsequent chunks as not', () => {
      const { result } = renderHook(() => useStreamingMetrics());

      act(() => result.current.recordMessage());
      expect(result.current.isFirstChunk()).toBe(true);

      act(() => result.current.recordMessage());
      expect(result.current.isFirstChunk()).toBe(false);
    });

    it('resets the counter to first-chunk on a quest transition', () => {
      const { result } = renderHook(() => useStreamingMetrics());

      act(() => {
        result.current.handleQuestTransition('q1');
        result.current.recordMessage();
        result.current.recordMessage();
      });
      expect(result.current.isFirstChunk()).toBe(false);

      // Switching to a new quest resets the per-quest counter to 1.
      act(() => result.current.handleQuestTransition('q2'));
      expect(result.current.isFirstChunk()).toBe(true);
    });
  });

  describe('client first-token timing', () => {
    it('posts client timing once when a sent-time is recorded and the reply has a first token', async () => {
      sessionStorage.setItem('quest-q1-sent-time', String(Date.now() - 50));
      const { result } = renderHook(() => useStreamingMetrics());

      act(() => result.current.recordFirstTokenIfNeeded({ id: 'q1', replies: ['hello'] }));

      await waitFor(() => expect(apiPost).toHaveBeenCalledOnce());
      const [url, body] = apiPost.mock.calls[0] as [string, { clientFirstTokenTime: number }];
      expect(url).toBe('/api/quests/q1/client-timing');
      expect(body.clientFirstTokenTime).toBeGreaterThanOrEqual(0);
      // sessionStorage entry is cleaned up after recording.
      expect(sessionStorage.getItem('quest-q1-sent-time')).toBeNull();
    });

    it('does not post twice for the same quest', async () => {
      sessionStorage.setItem('quest-q1-sent-time', String(Date.now() - 50));
      const { result } = renderHook(() => useStreamingMetrics());

      act(() => {
        result.current.recordFirstTokenIfNeeded({ id: 'q1', replies: ['hello'] });
        result.current.recordFirstTokenIfNeeded({ id: 'q1', replies: ['hello world'] });
      });

      await waitFor(() => expect(apiPost).toHaveBeenCalledOnce());
    });

    it('does nothing when there is no recorded sent-time', () => {
      const { result } = renderHook(() => useStreamingMetrics());

      act(() => result.current.recordFirstTokenIfNeeded({ id: 'q1', replies: ['hello'] }));

      expect(apiPost).not.toHaveBeenCalled();
    });

    it('does nothing when the reply has no first token yet', () => {
      sessionStorage.setItem('quest-q1-sent-time', String(Date.now() - 50));
      const { result } = renderHook(() => useStreamingMetrics());

      act(() => result.current.recordFirstTokenIfNeeded({ id: 'q1', replies: ['   '] }));

      expect(apiPost).not.toHaveBeenCalled();
    });

    it('re-allows recording for a quest after reset', async () => {
      sessionStorage.setItem('quest-q1-sent-time', String(Date.now() - 50));
      const { result } = renderHook(() => useStreamingMetrics());

      act(() => result.current.recordFirstTokenIfNeeded({ id: 'q1', replies: ['hello'] }));
      await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));

      sessionStorage.setItem('quest-q1-sent-time', String(Date.now() - 50));
      act(() => {
        result.current.reset();
        result.current.recordFirstTokenIfNeeded({ id: 'q1', replies: ['hello'] });
      });
      await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    });
  });

  it('returns a referentially stable api across re-renders', () => {
    const { result, rerender } = renderHook(() => useStreamingMetrics());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
