import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Fake WebRTC primitives
type Handler = (ev?: unknown) => void;

function makeFakePc() {
  const handlers: Record<string, Handler[]> = {};
  const pc = {
    connectionState: 'new' as RTCPeerConnectionState,
    iceConnectionState: 'new' as RTCIceConnectionState,
    addEventListener: (type: string, cb: Handler) => {
      (handlers[type] ||= []).push(cb);
    },
    removeEventListener: vi.fn(),
    getSenders: () => [] as RTCRtpSender[],
    close: vi.fn(() => {
      pc.connectionState = 'closed';
    }),
    // Test helper: set a state then fire its change event.
    __emit: (type: 'connectionstatechange' | 'iceconnectionstatechange', state: string) => {
      if (type === 'connectionstatechange') pc.connectionState = state as RTCPeerConnectionState;
      else pc.iceConnectionState = state as RTCIceConnectionState;
      (handlers[type] || []).forEach(cb => cb());
    },
  };
  return pc;
}

function makeFakeDc() {
  const handlers: Record<string, Handler[]> = {};
  return {
    readyState: 'open' as RTCDataChannelState,
    addEventListener: (type: string, cb: Handler) => {
      (handlers[type] ||= []).push(cb);
    },
    send: vi.fn(),
    __emitMessage: (data: unknown) => {
      (handlers['message'] || []).forEach(cb => cb({ data: JSON.stringify(data) }));
    },
  };
}

const pcs: ReturnType<typeof makeFakePc>[] = [];
const dcs: ReturnType<typeof makeFakeDc>[] = [];
const latestPc = () => pcs[pcs.length - 1];
const latestDc = () => dcs[dcs.length - 1];

const setupRealtimeConnection = vi.fn(async () => {
  const pc = makeFakePc();
  const dc = makeFakeDc();
  pcs.push(pc);
  dcs.push(dc);
  return {
    pc,
    dc,
    userStream: { getAudioTracks: () => [{ enabled: true, stop: vi.fn() }], getTracks: () => [] },
    audioContext: { state: 'running', close: vi.fn() },
  };
});
const startRealtimeConnection = vi.fn().mockResolvedValue(undefined);

vi.mock('@client/app/components/Session/VoiceSessionModal/realtimeConnection', () => ({
  setupRealtimeConnection: () => setupRealtimeConnection(),
  startRealtimeConnection: (...args: unknown[]) => startRealtimeConnection(...args),
}));

// Context / dependency mocks
const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1', currentCredits: 100 }, refreshUser: vi.fn() }),
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ sendJsonMessage: vi.fn(), subscribeToAction: () => () => {} }),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => undefined,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('./useVoiceKeepAlive', () => ({
  useVoiceKeepAlive: () => {},
}));

import { useVoiceSessionEngine } from './useVoiceSessionEngine';
import { useVoiceSessionStore } from './voiceSessionStore';
import toast from 'react-hot-toast';

const VOICE_SESSION_RESPONSE = {
  data: { session: { id: 's1' }, model: 'gpt-realtime', voice: 'alloy', ephemeralKey: 'ek-1' },
};

// Drive the hook to a fully-connected state.
async function connectAndConnected() {
  const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
  await act(async () => {
    await view.result.current.connect();
  });
  act(() => {
    latestDc().__emitMessage({ type: 'session.created' });
  });
  expect(view.result.current.connectionStatus).toBe('connected');
  return view;
}

describe('useVoiceSessionEngine — WebRTC auto-reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pcs.length = 0;
    dcs.length = 0;
    setupRealtimeConnection.mockClear();
    startRealtimeConnection.mockClear();
    (toast.error as ReturnType<typeof vi.fn>).mockClear();
    apiPost.mockReset();
    apiPost.mockResolvedValue(VOICE_SESSION_RESPONSE);
    useVoiceSessionStore.getState().reset();
    // jsdom doesn't implement these - keep the audio-element teardown quiet.
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enters reconnecting and re-establishes on a failed peer connection', async () => {
    const view = await connectAndConnected();
    expect(apiPost).toHaveBeenCalledTimes(1);

    // Peer connection drops (mobile network handoff).
    act(() => {
      latestPc().__emit('connectionstatechange', 'failed');
    });
    expect(view.result.current.connectionStatus).toBe('reconnecting');

    // Backoff elapses -> a fresh session token is fetched and a new pc set up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(setupRealtimeConnection).toHaveBeenCalledTimes(2);
    // The re-bootstrap must flag itself as a reconnect so the server reuses the
    // existing credit hold instead of charging a second full reservation.
    const bootstrapCalls = apiPost.mock.calls.filter(([url]) => url === '/api/ai/voice-sessions');
    expect(bootstrapCalls[0][1]).toMatchObject({ isReconnect: false });
    expect(bootstrapCalls[1][1]).toMatchObject({ isReconnect: true });

    // The new connection comes up -> back to connected.
    act(() => {
      latestDc().__emitMessage({ type: 'session.created' });
    });
    expect(view.result.current.connectionStatus).toBe('connected');
  });

  it('ignores the disconnected→failed pair as a single reconnect', async () => {
    const view = await connectAndConnected();

    act(() => {
      latestPc().__emit('iceconnectionstatechange', 'disconnected');
      latestPc().__emit('connectionstatechange', 'failed');
    });
    expect(view.result.current.connectionStatus).toBe('reconnecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Only ONE reconnect scheduled despite two state events.
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('gives up with an honest disconnected state after exhausting attempts', async () => {
    const view = await connectAndConnected();

    // Each reconnect re-establishes but the new connection never reaches
    // session.created, then drops again.
    for (let i = 0; i < 3; i++) {
      act(() => {
        latestPc().__emit('connectionstatechange', 'failed');
      });
      expect(view.result.current.connectionStatus).toBe('reconnecting');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
    }

    // Budget exhausted - the next drop tears down honestly (no stale 'connected').
    act(() => {
      latestPc().__emit('connectionstatechange', 'failed');
    });
    expect(view.result.current.connectionStatus).toBe('disconnected');
    expect(toast.error).toHaveBeenCalled();
  });

  it('tears down a freshly-built connection instead of parking it when End fires mid-setup', async () => {
    // setupRealtimeConnection is in flight when the user hits End. The closure's
    // isEnding is stale across that await, so the engine must read the live store
    // and close the new pc rather than assign it to the (already-cleared) refs.
    let resolveSetup!: (v: unknown) => void;
    const pendingSetup = new Promise(resolve => {
      resolveSetup = resolve;
    });
    const pc = makeFakePc();
    const dc = makeFakeDc();
    setupRealtimeConnection.mockImplementationOnce(() => pendingSetup);

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = view.result.current.connect();
    });

    // End is clicked while the connection is still being built.
    act(() => {
      useVoiceSessionStore.getState().setEnding(true);
    });

    await act(async () => {
      resolveSetup({
        pc,
        dc,
        userStream: { getAudioTracks: () => [], getTracks: () => [] },
        audioContext: { state: 'running', close: vi.fn() },
      });
      await connectPromise;
    });

    // The fresh peer connection was closed, not parked in a ref.
    expect(pc.close).toHaveBeenCalled();
  });
});
