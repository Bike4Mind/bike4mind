import { create } from 'zustand';
import perfLogger from '../utils/performanceLogger';

export type StreamingStatus = 'idle' | 'streaming' | 'error' | 'cancelled';

interface StreamingInfo {
  status: StreamingStatus;
  questId?: string;
  lastChunkTime: number;
  startTime: number;
}

interface StreamingStateStore {
  // Per-session streaming state (supports multi-tab, session switching)
  sessions: Map<string, StreamingInfo>;

  // Actions
  startStreaming: (sessionId: string, questId?: string) => void;
  receiveChunk: (sessionId: string) => void;
  completeStreaming: (sessionId: string) => void;
  errorStreaming: (sessionId: string) => void;
  cancelStreaming: (sessionId: string) => void;
  resetStreaming: (sessionId: string) => void;

  // Selectors
  isStreamingSession: (sessionId: string) => boolean;
  isAnyStreaming: () => boolean;
  getStreamingInfo: (sessionId: string) => StreamingInfo | undefined;
  getStreamingStatus: (sessionId: string) => StreamingStatus;
}

export const useStreamingState = create<StreamingStateStore>((set, get) => ({
  sessions: new Map(),

  startStreaming: (sessionId, questId) =>
    set(state => {
      const newSessions = new Map(state.sessions);
      const now = Date.now();
      const previousStatus = state.sessions.get(sessionId)?.status ?? 'idle';

      // Auto-clear error/cancelled state when starting new stream for same session
      newSessions.set(sessionId, {
        status: 'streaming',
        questId,
        lastChunkTime: now,
        startTime: now,
      });

      perfLogger.log('[STREAMING] State transition', {
        sessionId,
        questId,
        from: previousStatus,
        to: 'streaming',
      });

      return { sessions: newSessions };
    }),

  receiveChunk: sessionId =>
    set(state => {
      const existing = state.sessions.get(sessionId);
      // Only update if actively streaming - avoid unnecessary re-renders
      if (!existing || existing.status !== 'streaming') {
        return state; // No change, no re-render
      }

      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, {
        ...existing,
        lastChunkTime: Date.now(),
      });
      return { sessions: newSessions };
    }),

  completeStreaming: sessionId =>
    set(state => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (existing) {
        perfLogger.log('[STREAMING] State transition', {
          sessionId,
          questId: existing.questId,
          from: existing.status,
          to: 'idle',
          duration: Date.now() - existing.startTime,
        });
      }
      // Remove the session entry to reset to idle
      newSessions.delete(sessionId);
      return { sessions: newSessions };
    }),

  errorStreaming: sessionId =>
    set(state => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (existing) {
        perfLogger.log('[STREAMING] State transition', {
          sessionId,
          questId: existing.questId,
          from: existing.status,
          to: 'error',
        });
        newSessions.set(sessionId, {
          ...existing,
          status: 'error',
        });
      }
      return { sessions: newSessions };
    }),

  cancelStreaming: sessionId =>
    set(state => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (existing) {
        perfLogger.log('[STREAMING] State transition', {
          sessionId,
          questId: existing.questId,
          from: existing.status,
          to: 'cancelled',
        });
        newSessions.set(sessionId, {
          ...existing,
          status: 'cancelled',
        });
      }
      return { sessions: newSessions };
    }),

  resetStreaming: sessionId =>
    set(state => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (existing) {
        perfLogger.log('[STREAMING] State transition (reset)', {
          sessionId,
          questId: existing.questId,
          from: existing.status,
          to: 'idle',
        });
      }
      newSessions.delete(sessionId);
      return { sessions: newSessions };
    }),

  isStreamingSession: sessionId => {
    const info = get().sessions.get(sessionId);
    return info?.status === 'streaming';
  },

  isAnyStreaming: () => {
    for (const info of get().sessions.values()) {
      if (info.status === 'streaming') return true;
    }
    return false;
  },

  getStreamingInfo: sessionId => {
    return get().sessions.get(sessionId);
  },

  getStreamingStatus: sessionId => {
    return get().sessions.get(sessionId)?.status ?? 'idle';
  },
}));
