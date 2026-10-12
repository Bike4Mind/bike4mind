import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import type { DisconnectionDetails } from '@elevenlabs/client';

// Mocks
// Capture the callbacks passed to Conversation.startSession so the test can
// drive onConnect/onDisconnect like the real SDK would on a network event.
type StartSessionOptions = Parameters<typeof import('@elevenlabs/client').Conversation.startSession>[0];
let capturedOptions: StartSessionOptions | null = null;
const endSessionMock = vi.fn().mockResolvedValue(undefined);

const startSessionMock = vi.fn(async (options: StartSessionOptions) => {
  capturedOptions = options;
  return { endSession: endSessionMock } as unknown as Awaited<
    ReturnType<typeof import('@elevenlabs/client').Conversation.startSession>
  >;
});

vi.mock('@elevenlabs/client', () => ({
  Conversation: {
    startSession: (options: StartSessionOptions) => startSessionMock(options),
  },
}));

const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

const axiosFailure = (status: number) =>
  new AxiosError('request failed', 'ERR_BAD_RESPONSE', undefined, undefined, { status } as AxiosResponse);
// An axios error with no response is how a dropped connection reaches the settlement queue.
const networkFailure = () => new AxiosError('Network Error', 'ERR_NETWORK');

const userState = vi.hoisted(() => ({ currentUser: { id: 'user-1' } as { id: string } | null }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: { getState: () => userState },
}));

import { useConversationalVoiceStore } from './useConversationalVoice';

const stopTrack = vi.fn();
const getUserMedia = vi.fn();
Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });

const BOOTSTRAP = {
  session: { id: 's1', name: 'Voice' },
  reasoningModelId: 'model-x',
  clientBootstrap: {
    transport: 'elevenlabs-conversational',
    signedUrl: 'wss://example/signed',
    agentId: 'agent-1',
    sessionToken: 'tok-1',
  },
};

// Helper: invoke the SDK callbacks the store registered on the most recent
// startSession call.
const onConnect = () => capturedOptions?.onConnect?.();
const onDisconnect = (details: DisconnectionDetails) => capturedOptions?.onDisconnect?.(details);

describe('useConversationalVoice — auto-reconnect', () => {
  beforeEach(() => {
    userState.currentUser = { id: 'user-1' };
    vi.useFakeTimers();
    capturedOptions = null;
    startSessionMock.mockClear();
    endSessionMock.mockClear();
    stopTrack.mockClear();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    apiPost.mockReset();
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/voice/v2/sessions') return Promise.resolve({ data: BOOTSTRAP });
      return Promise.resolve({ data: {} }); // /sessions/:id/end
    });
  });

  afterEach(async () => {
    // Clean module-level singletons between tests.
    await useConversationalVoiceStore.getState().end();
    vi.useRealTimers();
  });

  const endCalls = () => apiPost.mock.calls.filter(([url]) => String(url).endsWith('/end'));

  it('reconnects on an abnormal disconnect without reconciling credits mid-flight', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();
    expect(useConversationalVoiceStore.getState().phase).toBe('connected');
    expect(startSessionMock).toHaveBeenCalledTimes(1);

    // Network drop (the SDK reports reason 'error').
    onDisconnect({ reason: 'error', message: 'socket closed', context: new Event('close') });
    expect(useConversationalVoiceStore.getState().phase).toBe('reconnecting');

    // Backoff elapses -> a fresh connection is established on the same session.
    await vi.advanceTimersByTimeAsync(1000);
    expect(startSessionMock).toHaveBeenCalledTimes(2);
    // Credits must NOT be reconciled during a reconnect (that would end the hold).
    expect(endCalls()).toHaveLength(0);
    // The re-bootstrap must flag itself as a reconnect so the server reuses the
    // existing credit hold instead of charging a second full reservation.
    const bootstrapCalls = apiPost.mock.calls.filter(([url]) => url === '/api/voice/v2/sessions');
    expect(bootstrapCalls).toHaveLength(2);
    expect(bootstrapCalls[0][1]).toMatchObject({ isReconnect: false });
    expect(bootstrapCalls[1][1]).toMatchObject({ isReconnect: true });

    onConnect();
    expect(useConversationalVoiceStore.getState().phase).toBe('connected');
  });

  it('does not reconnect when the user ends the call', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();

    await useConversationalVoiceStore.getState().end();
    expect(useConversationalVoiceStore.getState().phase).toBe('ended');

    // A late user-reason disconnect must be ignored (superseded), and no timer
    // should re-establish anything.
    onDisconnect({ reason: 'user', context: new CloseEvent('close') });
    await vi.advanceTimersByTimeAsync(5000);
    expect(startSessionMock).toHaveBeenCalledTimes(1);
  });

  it('gives up and ends after exhausting reconnect attempts', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();

    const drop = () => onDisconnect({ reason: 'error', message: 'drop', context: new Event('close') });

    // Three reconnect attempts: each re-establishes but immediately drops again.
    for (let i = 0; i < 3; i++) {
      drop();
      expect(useConversationalVoiceStore.getState().phase).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(4000);
    }

    // Budget exhausted - the next drop ends the call and reconciles credits.
    drop();
    expect(useConversationalVoiceStore.getState().phase).toBe('ended');
    expect(endCalls()).toHaveLength(1);
  });

  it('reconciles the credit hold when reconnect bootstraps keep failing', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();
    let offline = true;
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions' || offline ? Promise.reject(networkFailure()) : Promise.resolve({ data: {} })
    );

    onDisconnect({ reason: 'error', message: 'drop', context: new Event('close') });
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);

    offline = false;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(endCalls()).toHaveLength(2);
    // The server measures the call itself; the client sends no usage claims.
    expect(endCalls().map(call => call.length)).toEqual([1, 1]);
  });

  it('does not start another call on the same session while its hold is unsettled', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();
    let settlementOffline = true;
    apiPost.mockImplementation((url: string) => {
      if (String(url).endsWith('/end') && settlementOffline) return Promise.reject(networkFailure());
      if (url === '/api/voice/v2/sessions') return Promise.resolve({ data: BOOTSTRAP });
      return Promise.resolve({ data: {} });
    });

    await useConversationalVoiceStore.getState().end();
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });

    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(apiPost.mock.calls.filter(([url]) => url === '/api/voice/v2/sessions')).toHaveLength(1);

    settlementOffline = false;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('useConversationalVoice - credit hold on a failed start', () => {
  beforeEach(() => {
    userState.currentUser = { id: 'user-1' };
    startSessionMock.mockClear();
    stopTrack.mockClear();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    apiPost.mockReset();
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/voice/v2/sessions') return Promise.resolve({ data: BOOTSTRAP });
      return Promise.resolve({ data: {} });
    });
  });

  afterEach(async () => {
    await useConversationalVoiceStore.getState().end();
  });

  const sessionCalls = () => apiPost.mock.calls.filter(([url]) => url === '/api/voice/v2/sessions');
  const endCalls = () => apiPost.mock.calls.filter(([url]) => String(url).endsWith('/end'));

  it('never bootstraps (so never reserves credits) when no microphone is available', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }));

    await useConversationalVoiceStore.getState().start({});

    expect(sessionCalls()).toHaveLength(0);
    expect(startSessionMock).not.toHaveBeenCalled();
    const state = useConversationalVoiceStore.getState();
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toMatch(/No microphone detected/);
  });

  it('releases the mic probe before bootstrapping', async () => {
    await useConversationalVoiceStore.getState().start({});

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(sessionCalls()).toHaveLength(1);
  });

  it('reconciles the credit hold when the transport fails to open after bootstrap', async () => {
    startSessionMock.mockRejectedValueOnce(new Error('websocket refused'));

    await useConversationalVoiceStore.getState().start({});

    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
    expect(endCalls()[0]).toHaveLength(1);
  });

  it('does not reserve credits when ended during the microphone probe', async () => {
    let resolveMicrophone: (stream: { getTracks: () => { stop: typeof stopTrack }[] }) => void = () => {
      throw new Error('Microphone probe was not started');
    };
    getUserMedia.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveMicrophone = resolve;
        })
    );

    const starting = useConversationalVoiceStore.getState().start({});
    await useConversationalVoiceStore.getState().end();
    resolveMicrophone({ getTracks: () => [{ stop: stopTrack }] });
    await starting;

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(sessionCalls()).toHaveLength(0);
    expect(useConversationalVoiceStore.getState().phase).toBe('ended');
  });
});

describe('useConversationalVoice - settlement retry queue', () => {
  const PENDING_KEY = 'voice-pending-settlements';
  const END_URL = '/api/voice/v2/sessions/s1/end';

  const endCalls = () => apiPost.mock.calls.filter(([url]) => String(url).endsWith('/end'));
  const loadStore = async () => (await import('./useConversationalVoice')).useConversationalVoiceStore;

  // Resolves the end-of-call settlement to `outcome` on every attempt.
  const settlementRespondsWith = (outcome: () => Promise<unknown>) =>
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions' ? Promise.resolve({ data: BOOTSTRAP }) : outcome()
    );

  const connectedCall = async () => {
    const store = await loadStore();
    await store.getState().start({ sessionId: 's1' });
    onConnect();
    return store;
  };

  beforeEach(() => {
    // The pending-settlement queue is read from sessionStorage when the module loads.
    vi.resetModules();
    sessionStorage.clear();
    userState.currentUser = { id: 'user-1' };
    vi.useFakeTimers();
    capturedOptions = null;
    startSessionMock.mockClear();
    endSessionMock.mockClear();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    apiPost.mockReset();
    settlementRespondsWith(() => Promise.resolve({ data: {} }));
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it.each([404, 403])('drops the settlement on a final %i and never retries it', async status => {
    settlementRespondsWith(() => Promise.reject(axiosFailure(status)));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = await connectedCall();

    await store.getState().end();
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(endCalls()).toHaveLength(1);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('retries a 503 until the settlement succeeds, then forgets it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    settlementRespondsWith(() => Promise.reject(axiosFailure(503)));
    const store = await connectedCall();

    await store.getState().end();
    expect(endCalls()).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? '[]')).toEqual([
      { sessionId: 's1', userId: 'user-1', attempts: 1 },
    ]);

    settlementRespondsWith(() => Promise.resolve({ data: {} }));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(endCalls()).toHaveLength(2);
    expect(endCalls().map(([url]) => url)).toEqual([END_URL, END_URL]);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('retries a 409 (provider still has the call open)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    settlementRespondsWith(() => Promise.reject(axiosFailure(409)));
    const store = await connectedCall();

    await store.getState().end();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(endCalls().length).toBeGreaterThanOrEqual(2);
  });

  it('stops retrying after 20 attempts and leaves the rest to the server sweep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    settlementRespondsWith(() => Promise.reject(axiosFailure(503)));
    const store = await connectedCall();

    await store.getState().end();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(endCalls()).toHaveLength(20);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('never sends a settlement persisted by another user', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify([{ sessionId: 'other-s', userId: 'someone-else', attempts: 0 }])
    );
    await loadStore();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(apiPost).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("replays the signed-in user's own persisted settlement", async () => {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify([{ sessionId: 's1', userId: 'user-1', attempts: 0 }]));
    await loadStore();

    await vi.advanceTimersByTimeAsync(5000);

    expect(endCalls().map(([url]) => url)).toEqual([END_URL]);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('settles the bootstrapped session when the call is ended while /sessions is still in flight', async () => {
    let resolveBootstrap: (value: { data: typeof BOOTSTRAP }) => void = () => {
      throw new Error('Bootstrap was not requested');
    };
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions'
        ? new Promise(resolve => {
            resolveBootstrap = resolve;
          })
        : Promise.resolve({ data: {} })
    );
    const store = await loadStore();

    const starting = store.getState().start({});
    await vi.advanceTimersByTimeAsync(0);
    await store.getState().end();
    expect(endCalls()).toHaveLength(0);

    resolveBootstrap({ data: BOOTSTRAP });
    await starting;
    await vi.advanceTimersByTimeAsync(0);

    expect(endCalls().map(([url]) => url)).toEqual([END_URL]);
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('does nothing, and queues nothing, when no user is signed in to settle the hold', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = await connectedCall();
    userState.currentUser = null;

    await store.getState().end();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(endCalls()).toHaveLength(0);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});
