import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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

const sendJsonMessage = vi.fn();
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ sendJsonMessage, subscribeToAction: () => () => {} }),
}));

const getUserMedia = vi.fn();
Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => undefined,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('./useVoiceKeepAlive', () => ({
  useVoiceKeepAlive: () => {},
}));

import { useVoiceSessionEngine } from './useVoiceSessionEngine';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useVoiceSessionStore } from './voiceSessionStore';
import { toast } from 'sonner';

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
    sendJsonMessage.mockClear();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    useVoiceSessionStore.getState().reset();
    // jsdom doesn't implement these - keep the audio-element teardown quiet.
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
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

  it('surfaces the server message and returns to disconnected when the first connect is rejected', async () => {
    apiPost.mockRejectedValueOnce({ response: { data: { error: 'Voice sessions are unavailable right now.' } } });

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    await act(async () => {
      await view.result.current.connect();
    });

    expect(toast.error).toHaveBeenCalledWith('Voice sessions are unavailable right now.', {
      id: 'voice-session-start-error',
    });
    expect(view.result.current.connectionStatus).toBe('disconnected');
    expect(setupRealtimeConnection).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the rejection carries no server message', async () => {
    apiPost.mockRejectedValueOnce(new Error('Network Error'));

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    await act(async () => {
      await view.result.current.connect();
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to start voice session.', {
      id: 'voice-session-start-error',
    });
    expect(view.result.current.connectionStatus).toBe('disconnected');
  });

  it('still rejects a failed reconnect so the backoff owns the retry', async () => {
    const view = await connectAndConnected();
    const failure = { response: { data: { error: 'Voice sessions are unavailable right now.' } } };
    apiPost.mockRejectedValueOnce(failure);

    await act(async () => {
      await expect(view.result.current.connect({ isReconnect: true })).rejects.toBe(failure);
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  const settlementFrames = () =>
    sendJsonMessage.mock.calls.map(([frame]) => frame).filter(frame => frame.action === 'voice_session_ended');
  const ZERO_SETTLEMENT = {
    action: 'voice_session_ended',
    sessionId: 's1',
    model: 'gpt-realtime',
    userId: 'u1',
    usage: {
      audioInputTokens: 0,
      audioCachedInputTokens: 0,
      audioOutputTokens: 0,
      textInputTokens: 0,
      textCachedInputTokens: 0,
      textOutputTokens: 0,
    },
  };

  it('never bootstraps (so never reserves credits) when no microphone is available', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }));

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    await act(async () => {
      await view.result.current.connect();
    });

    expect(apiPost).not.toHaveBeenCalled();
    expect(setupRealtimeConnection).not.toHaveBeenCalled();
    expect(view.result.current.connectionStatus).toBe('disconnected');
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/No microphone detected/), {
      id: 'voice-session-start-error',
    });
  });

  it('settles the credit hold at zero usage when the connection fails after bootstrap', async () => {
    setupRealtimeConnection.mockRejectedValueOnce(Object.assign(new Error('mic gone'), { name: 'NotFoundError' }));

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    await act(async () => {
      await view.result.current.connect();
    });

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(view.result.current.connectionStatus).toBe('disconnected');
    expect(settlementFrames()).toEqual([ZERO_SETTLEMENT]);
  });

  it('settles the credit hold when reconnects are exhausted before any response', async () => {
    const view = await connectAndConnected();

    for (let i = 0; i < 3; i++) {
      act(() => {
        latestPc().__emit('connectionstatechange', 'failed');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
    }
    act(() => {
      latestPc().__emit('connectionstatechange', 'failed');
    });

    expect(view.result.current.connectionStatus).toBe('disconnected');
    expect(settlementFrames()).toEqual([ZERO_SETTLEMENT]);
  });

  const responseDone = (id: string, audioOutputTokens: number) => ({
    type: 'response.done',
    response: {
      id,
      usage: {
        input_token_details: {
          audio_tokens: 1,
          text_tokens: 0,
          cached_tokens_details: { audio_tokens: 0, text_tokens: 0 },
        },
        output_token_details: { audio_tokens: audioOutputTokens, text_tokens: 0 },
      },
    },
  });

  it('bills each response by its id and closes the hold once when the call ends', async () => {
    const view = await connectAndConnected();
    act(() => {
      latestDc().__emitMessage(responseDone('resp-1', 10));
      latestDc().__emitMessage(responseDone('resp-2', 20));
    });
    act(() => {
      view.result.current.endSession();
    });
    act(() => {
      latestDc().__emitMessage(responseDone('resp-3', 5));
    });

    const frames = settlementFrames();
    expect(frames.map(f => f.responseId)).toEqual(['resp-1', 'resp-2', 'resp-3', undefined]);
    expect(frames[1].usage).toMatchObject({ audioOutputTokens: 20 });
    // The closing frame carries no usage of its own; every response was billed by id.
    expect(frames[3]).toMatchObject({ sessionId: 's1', usage: { audioOutputTokens: 0, audioInputTokens: 0 } });
  });

  it('keeps the hold open across a reconnect and closes it only when the call ends', async () => {
    const view = await connectAndConnected();
    act(() => {
      latestDc().__emitMessage(responseDone('resp-1', 10));
      latestPc().__emit('connectionstatechange', 'failed');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    act(() => {
      latestDc().__emitMessage({ type: 'session.created' });
    });
    expect(settlementFrames().filter(f => !f.responseId)).toHaveLength(0);

    act(() => {
      view.result.current.endSession();
    });
    act(() => {
      latestDc().__emitMessage(responseDone('resp-2', 5));
    });
    expect(settlementFrames().filter(f => !f.responseId)).toHaveLength(1);
  });

  it('stops every track of the microphone probe so the mic indicator goes off', async () => {
    const stops = [vi.fn(), vi.fn()];
    getUserMedia.mockResolvedValue({ getTracks: () => stops.map(stop => ({ stop })) });

    await connectAndConnected();

    stops.forEach(stop => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('settles the hold when the tab is closed mid-call, which runs no React teardown', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    useAccessToken.setState({ accessToken: 'tok' });
    try {
      await connectAndConnected();

      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      expect(settlementFrames()).toEqual([ZERO_SETTLEMENT]);
      // The frame can be dropped as the page unloads; a keepalive end request is the backstop.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/voice/v2/sessions/s1/end',
        expect.objectContaining({
          method: 'POST',
          keepalive: true,
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        })
      );

      // A second pagehide (e.g. after a bfcache restore) has no hold left to end.
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      useAccessToken.setState({ accessToken: null });
    }
  });

  it('sends no end request on pagehide when no hold is open', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('settles an unsettled hold on unmount, and a failing socket does not break teardown', async () => {
    const view = await connectAndConnected();
    sendJsonMessage.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });

    expect(() => view.unmount()).not.toThrow();

    expect(settlementFrames()).toEqual([ZERO_SETTLEMENT]);
    expect(latestPc().close).toHaveBeenCalled();
  });

  it('hands the hold to the remounted instance instead of settling it when a new session navigates', async () => {
    const first = renderHook(() => useVoiceSessionEngine({}));
    await act(async () => {
      await first.result.current.connect();
    });
    expect(apiPost).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(settlementFrames()).toEqual([]);

    setupRealtimeConnection.mockRejectedValueOnce(new Error('setup failed'));
    await act(async () => {
      renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(settlementFrames()).toEqual([ZERO_SETTLEMENT]);
  });

  it('does not bootstrap when End is pressed while the microphone prompt is open', async () => {
    let allowMicrophone: (stream: unknown) => void = () => {};
    getUserMedia.mockReturnValue(new Promise(resolve => (allowMicrophone = resolve)));

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    await act(async () => {
      void view.result.current.connect();
    });
    act(() => {
      view.result.current.endSession();
    });
    await act(async () => {
      allowMicrophone({ getTracks: () => [{ stop: vi.fn() }] });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(apiPost).not.toHaveBeenCalledWith('/api/ai/voice-sessions', expect.anything());
    expect(setupRealtimeConnection).not.toHaveBeenCalled();
    expect(settlementFrames()).toEqual([]);
  });

  it('settles a hold reserved after End ran mid-bootstrap, and opens no connection', async () => {
    let finishBootstrap: (response: unknown) => void = () => {};
    apiPost.mockReturnValue(new Promise(resolve => (finishBootstrap = resolve)));

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    await act(async () => {
      void view.result.current.connect();
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      view.result.current.endSession();
    });
    expect(settlementFrames()).toEqual([]);

    await act(async () => {
      finishBootstrap(VOICE_SESSION_RESPONSE);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(setupRealtimeConnection).not.toHaveBeenCalled();
    expect(settlementFrames()).toEqual([ZERO_SETTLEMENT]);
  });

  it('reports a generic microphone message for an unrecognised capture failure', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('boom'), { name: 'AbortError' }));

    const view = renderHook(() => useVoiceSessionEngine({ sessionId: 's1' }));
    await act(async () => {
      await view.result.current.connect();
    });

    expect(apiPost).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Could not start the microphone/), {
      id: 'voice-session-start-error',
    });
  });
});
