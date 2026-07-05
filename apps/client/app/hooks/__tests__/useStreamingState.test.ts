import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStreamingState } from '../useStreamingState';

describe('useStreamingState', () => {
  beforeEach(() => {
    useStreamingState.setState({ sessions: new Map() });
    vi.clearAllMocks();
  });

  describe('startStreaming', () => {
    it('should transition from idle to streaming', () => {
      const { startStreaming, getStreamingStatus } = useStreamingState.getState();

      expect(getStreamingStatus('session-1')).toBe('idle');

      startStreaming('session-1', 'quest-1');

      expect(getStreamingStatus('session-1')).toBe('streaming');
    });

    it('should store questId when provided', () => {
      const { startStreaming, getStreamingInfo } = useStreamingState.getState();

      startStreaming('session-1', 'quest-123');

      const info = getStreamingInfo('session-1');
      expect(info?.questId).toBe('quest-123');
    });

    it('should set startTime and lastChunkTime', () => {
      const { startStreaming, getStreamingInfo } = useStreamingState.getState();
      const before = Date.now();

      startStreaming('session-1');

      const info = getStreamingInfo('session-1');
      expect(info?.startTime).toBeGreaterThanOrEqual(before);
      expect(info?.lastChunkTime).toBeGreaterThanOrEqual(before);
      expect(info?.startTime).toBe(info?.lastChunkTime);
    });

    it('should auto-clear error state when starting new stream', () => {
      const { startStreaming, errorStreaming, getStreamingStatus } = useStreamingState.getState();

      startStreaming('session-1');
      errorStreaming('session-1');
      expect(getStreamingStatus('session-1')).toBe('error');

      startStreaming('session-1', 'quest-2');
      expect(getStreamingStatus('session-1')).toBe('streaming');
    });

    it('should auto-clear cancelled state when starting new stream', () => {
      const { startStreaming, cancelStreaming, getStreamingStatus } = useStreamingState.getState();

      startStreaming('session-1');
      cancelStreaming('session-1');
      expect(getStreamingStatus('session-1')).toBe('cancelled');

      startStreaming('session-1', 'quest-2');
      expect(getStreamingStatus('session-1')).toBe('streaming');
    });
  });

  describe('receiveChunk', () => {
    it('should update lastChunkTime when streaming', async () => {
      vi.useFakeTimers();
      try {
        const { startStreaming, receiveChunk, getStreamingInfo } = useStreamingState.getState();

        startStreaming('session-1');
        const initialTime = getStreamingInfo('session-1')?.lastChunkTime;

        await vi.advanceTimersByTimeAsync(10);

        receiveChunk('session-1');

        const newTime = getStreamingInfo('session-1')?.lastChunkTime;
        expect(newTime).toBe(initialTime! + 10);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not update state when not streaming (optimization)', () => {
      const { receiveChunk, getStreamingInfo } = useStreamingState.getState();

      receiveChunk('session-1');

      expect(getStreamingInfo('session-1')).toBeUndefined();
    });

    it('should not update state when in error status', () => {
      const { startStreaming, errorStreaming, receiveChunk, getStreamingInfo } = useStreamingState.getState();

      startStreaming('session-1');
      errorStreaming('session-1');
      const errorTime = getStreamingInfo('session-1')?.lastChunkTime;

      receiveChunk('session-1');

      expect(getStreamingInfo('session-1')?.lastChunkTime).toBe(errorTime);
    });
  });

  describe('completeStreaming', () => {
    it('should transition from streaming to idle', () => {
      const { startStreaming, completeStreaming, getStreamingStatus, isStreamingSession } =
        useStreamingState.getState();

      startStreaming('session-1');
      expect(isStreamingSession('session-1')).toBe(true);

      completeStreaming('session-1');

      expect(getStreamingStatus('session-1')).toBe('idle');
      expect(isStreamingSession('session-1')).toBe(false);
    });

    it('should remove session from sessions map', () => {
      const { startStreaming, completeStreaming, getStreamingInfo } = useStreamingState.getState();

      startStreaming('session-1');
      expect(getStreamingInfo('session-1')).toBeDefined();

      completeStreaming('session-1');

      expect(getStreamingInfo('session-1')).toBeUndefined();
    });

    it('should be safe to call on non-streaming session', () => {
      const { completeStreaming, getStreamingStatus } = useStreamingState.getState();

      completeStreaming('non-existent-session');

      expect(getStreamingStatus('non-existent-session')).toBe('idle');
    });
  });

  describe('errorStreaming', () => {
    it('should transition to error state', () => {
      const { startStreaming, errorStreaming, getStreamingStatus } = useStreamingState.getState();

      startStreaming('session-1');
      errorStreaming('session-1');

      expect(getStreamingStatus('session-1')).toBe('error');
    });

    it('should preserve questId and timing info', () => {
      const { startStreaming, errorStreaming, getStreamingInfo } = useStreamingState.getState();

      startStreaming('session-1', 'quest-123');
      const originalInfo = getStreamingInfo('session-1');

      errorStreaming('session-1');

      const errorInfo = getStreamingInfo('session-1');
      expect(errorInfo?.questId).toBe('quest-123');
      expect(errorInfo?.startTime).toBe(originalInfo?.startTime);
    });

    it('should be safe to call on non-streaming session', () => {
      const { errorStreaming, getStreamingStatus } = useStreamingState.getState();

      errorStreaming('non-existent-session');

      expect(getStreamingStatus('non-existent-session')).toBe('idle');
    });
  });

  describe('cancelStreaming', () => {
    it('should transition to cancelled state', () => {
      const { startStreaming, cancelStreaming, getStreamingStatus } = useStreamingState.getState();

      startStreaming('session-1');
      cancelStreaming('session-1');

      expect(getStreamingStatus('session-1')).toBe('cancelled');
    });
  });

  describe('resetStreaming', () => {
    it('should reset to idle from any state', () => {
      const { startStreaming, errorStreaming, resetStreaming, getStreamingStatus } = useStreamingState.getState();

      startStreaming('session-1');
      errorStreaming('session-1');
      expect(getStreamingStatus('session-1')).toBe('error');

      resetStreaming('session-1');

      expect(getStreamingStatus('session-1')).toBe('idle');
    });

    it('should be safe to call on non-existent session', () => {
      const { resetStreaming, getStreamingStatus } = useStreamingState.getState();

      resetStreaming('non-existent-session');

      expect(getStreamingStatus('non-existent-session')).toBe('idle');
    });
  });

  describe('per-session isolation', () => {
    it('should track multiple sessions independently', () => {
      const { startStreaming, completeStreaming, isStreamingSession } = useStreamingState.getState();

      startStreaming('session-1', 'quest-1');
      startStreaming('session-2', 'quest-2');
      startStreaming('session-3', 'quest-3');

      expect(isStreamingSession('session-1')).toBe(true);
      expect(isStreamingSession('session-2')).toBe(true);
      expect(isStreamingSession('session-3')).toBe(true);

      completeStreaming('session-2');

      expect(isStreamingSession('session-1')).toBe(true);
      expect(isStreamingSession('session-2')).toBe(false);
      expect(isStreamingSession('session-3')).toBe(true);
    });

    it('should not affect other sessions when updating one', () => {
      const { startStreaming, receiveChunk, getStreamingInfo } = useStreamingState.getState();

      startStreaming('session-1');
      startStreaming('session-2');

      const session1Time = getStreamingInfo('session-1')?.lastChunkTime;
      const session2Time = getStreamingInfo('session-2')?.lastChunkTime;

      receiveChunk('session-1');

      expect(getStreamingInfo('session-2')?.lastChunkTime).toBe(session2Time);
      expect(getStreamingInfo('session-1')?.lastChunkTime).toBeGreaterThanOrEqual(session1Time!);
    });
  });

  describe('rapid message sequences', () => {
    it('should handle rapid start/complete cycles', () => {
      const { startStreaming, completeStreaming, isStreamingSession } = useStreamingState.getState();

      for (let i = 0; i < 10; i++) {
        startStreaming('session-1', `quest-${i}`);
        expect(isStreamingSession('session-1')).toBe(true);

        completeStreaming('session-1');
        expect(isStreamingSession('session-1')).toBe(false);
      }

      expect(isStreamingSession('session-1')).toBe(false);
    });

    it('should handle rapid receiveChunk calls', () => {
      const { startStreaming, receiveChunk, getStreamingInfo } = useStreamingState.getState();

      startStreaming('session-1');

      for (let i = 0; i < 100; i++) {
        receiveChunk('session-1');
      }

      const info = getStreamingInfo('session-1');
      expect(info?.status).toBe('streaming');
    });
  });

  describe('session switching during stream', () => {
    it('should maintain state when user switches sessions', () => {
      const { startStreaming, getStreamingInfo, isStreamingSession } = useStreamingState.getState();

      startStreaming('session-1', 'quest-1');

      startStreaming('session-2', 'quest-2');

      expect(isStreamingSession('session-1')).toBe(true);
      expect(isStreamingSession('session-2')).toBe(true);

      const info1 = getStreamingInfo('session-1');
      const info2 = getStreamingInfo('session-2');

      expect(info1?.questId).toBe('quest-1');
      expect(info2?.questId).toBe('quest-2');
    });
  });

  describe('selectors', () => {
    it('isStreamingSession should return true only when status is streaming', () => {
      const { startStreaming, errorStreaming, cancelStreaming, isStreamingSession } = useStreamingState.getState();

      expect(isStreamingSession('session-1')).toBe(false); // idle

      startStreaming('session-1');
      expect(isStreamingSession('session-1')).toBe(true); // streaming

      errorStreaming('session-1');
      expect(isStreamingSession('session-1')).toBe(false); // error

      startStreaming('session-2');
      cancelStreaming('session-2');
      expect(isStreamingSession('session-2')).toBe(false); // cancelled
    });

    it('getStreamingStatus should return idle for non-existent sessions', () => {
      const { getStreamingStatus } = useStreamingState.getState();

      expect(getStreamingStatus('non-existent')).toBe('idle');
    });

    it('getStreamingInfo should return undefined for non-existent sessions', () => {
      const { getStreamingInfo } = useStreamingState.getState();

      expect(getStreamingInfo('non-existent')).toBeUndefined();
    });
  });

  describe('timeout detection support', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should track lastChunkTime for timeout detection', async () => {
      const { startStreaming, receiveChunk, getStreamingInfo } = useStreamingState.getState();

      startStreaming('session-1');
      const startTime = getStreamingInfo('session-1')?.lastChunkTime ?? 0;

      await vi.advanceTimersByTimeAsync(50);

      receiveChunk('session-1');
      const afterChunkTime = getStreamingInfo('session-1')?.lastChunkTime ?? 0;

      const timeSinceStart = afterChunkTime - startTime;
      expect(timeSinceStart).toBe(50);
    });
  });
});
