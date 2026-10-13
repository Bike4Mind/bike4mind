import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { useConversationalVoiceStore } from './useConversationalVoice';

const stopTrack = vi.fn();
const getUserMedia = vi.fn();
const micStream = () => ({ getTracks: () => [{ stop: stopTrack }] });
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
    vi.useFakeTimers();
    capturedOptions = null;
    startSessionMock.mockClear();
    endSessionMock.mockClear();
    stopTrack.mockClear();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue(micStream());
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

  it('settles the hold when every reconnect bootstrap fails', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions' ? Promise.reject(new Error('offline')) : Promise.resolve({ data: {} })
    );

    onDisconnect({ reason: 'error', message: 'drop', context: new Event('close') });
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
  });

  it('settles the hold when every reconnect transport fails to open', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();
    startSessionMock.mockRejectedValue(new Error('websocket refused'));

    try {
      onDisconnect({ reason: 'error', message: 'drop', context: new Event('close') });
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

      expect(useConversationalVoiceStore.getState().phase).toBe('error');
      expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
    } finally {
      startSessionMock.mockImplementation(async (options: StartSessionOptions) => {
        capturedOptions = options;
        return { endSession: endSessionMock } as unknown as Awaited<
          ReturnType<typeof import('@elevenlabs/client').Conversation.startSession>
        >;
      });
    }
  });

  const activityCalls = () => apiPost.mock.calls.filter(([url]) => String(url).endsWith('/activity'));

  it('reports the call connected, beats while it stays up, and stops once it ends', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    expect(activityCalls()).toHaveLength(0);

    onConnect();
    expect(activityCalls()).toEqual([['/api/voice/v2/sessions/s1/activity', { sessionToken: 'tok-1' }]]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(activityCalls()).toHaveLength(3);

    await useConversationalVoiceStore.getState().end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(activityCalls()).toHaveLength(3);
  });

  it('stops beating while a dropped call reconnects', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    onConnect();
    onDisconnect({ reason: 'error', message: 'drop', context: new Event('close') });

    // The reconnect re-establishes but never comes back up.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(activityCalls()).toHaveLength(1);
  });
});

describe('useConversationalVoice - credit hold on a failed start', () => {
  beforeEach(() => {
    startSessionMock.mockClear();
    stopTrack.mockClear();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue(micStream());
    apiPost.mockReset();
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/voice/v2/sessions') return Promise.resolve({ data: BOOTSTRAP });
      return Promise.resolve({ data: {} });
    });
  });

  afterEach(async () => {
    await useConversationalVoiceStore.getState().end();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
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

  it('never bootstraps when microphone permission is denied', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));

    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });

    expect(sessionCalls()).toHaveLength(0);
    expect(useConversationalVoiceStore.getState().errorMessage).toMatch(/Microphone access denied/);
  });

  it('never bootstraps when the browser exposes no microphone API', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });

    await useConversationalVoiceStore.getState().start({});

    expect(sessionCalls()).toHaveLength(0);
    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(useConversationalVoiceStore.getState().errorMessage).toMatch(/https|does not support/);
  });

  it('releases the mic probe before bootstrapping', async () => {
    await useConversationalVoiceStore.getState().start({});

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(stopTrack.mock.invocationCallOrder[0]).toBeLessThan(apiPost.mock.invocationCallOrder[0]);
    expect(sessionCalls()).toHaveLength(1);
  });

  it('does not reserve credits when ended during the microphone probe', async () => {
    let resolveMicrophone: (stream: ReturnType<typeof micStream>) => void = () => {
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
    resolveMicrophone(micStream());
    await starting;

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(sessionCalls()).toHaveLength(0);
    expect(useConversationalVoiceStore.getState().phase).toBe('ended');
  });

  it('settles the hold when the transport fails to open on the first connect', async () => {
    startSessionMock.mockRejectedValueOnce(new Error('websocket refused'));

    await useConversationalVoiceStore.getState().start({});

    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
  });

  it('settles nothing when the first bootstrap itself fails', async () => {
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions' ? Promise.reject(new Error('503')) : Promise.resolve({ data: {} })
    );

    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });

    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(endCalls()).toHaveLength(0);
  });

  it('settles nothing when a concurrent call wins the bootstrap (409, server refunded the reserve)', async () => {
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions'
        ? Promise.reject(
            Object.assign(new Error('Request failed with status code 409'), {
              isAxiosError: true,
              response: { status: 409, data: { error: 'A voice call on this notebook is already starting' } },
            })
          )
        : Promise.resolve({ data: {} })
    );

    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });

    const state = useConversationalVoiceStore.getState();
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toMatch(/409/);
    expect(endCalls()).toHaveLength(0);
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('settles the bootstrapped session when the call is ended while /sessions is in flight', async () => {
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

    const starting = useConversationalVoiceStore.getState().start({});
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(1));
    await useConversationalVoiceStore.getState().end();
    expect(endCalls()).toHaveLength(0);

    resolveBootstrap({ data: BOOTSTRAP });
    await starting;

    expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('leaves a superseded bootstrap to the server when a newer call has already started', async () => {
    const resolvers: ((value: { data: typeof BOOTSTRAP }) => void)[] = [];
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions'
        ? new Promise(resolve => {
            resolvers.push(resolve);
          })
        : Promise.resolve({ data: {} })
    );

    const first = useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(1));
    await useConversationalVoiceStore.getState().end();
    const second = useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(2));

    resolvers[0]({ data: BOOTSTRAP });
    await first;
    // /end is keyed by notebook, so settling here could hit the newer call's hold.
    expect(endCalls()).toHaveLength(0);

    resolvers[1]({ data: BOOTSTRAP });
    await second;
    expect(startSessionMock).toHaveBeenCalledOnce();
  });

  describe('when the newer same-notebook bootstrap loses the conditional write (409)', () => {
    const conflict = () =>
      Object.assign(new Error('Request failed with status code 409'), {
        isAxiosError: true,
        response: { status: 409, data: { error: 'Another voice call on this session started at the same time' } },
      });
    let pending: { resolve: (value: { data: typeof BOOTSTRAP }) => void; reject: (err: unknown) => void }[];

    beforeEach(() => {
      pending = [];
      apiPost.mockImplementation((url: string) =>
        url === '/api/voice/v2/sessions'
          ? new Promise((resolve, reject) => {
              pending.push({ resolve, reject });
            })
          : Promise.resolve({ data: {} })
      );
    });

    const endThenRestart = async () => {
      const first = useConversationalVoiceStore.getState().start({ sessionId: 's1' });
      await vi.waitFor(() => expect(sessionCalls()).toHaveLength(1));
      await useConversationalVoiceStore.getState().end();
      const second = useConversationalVoiceStore.getState().start({ sessionId: 's1' });
      await vi.waitFor(() => expect(sessionCalls()).toHaveLength(2));
      return { first, second };
    };

    it('settles the superseded hold when the newer bootstrap fails after it resolves', async () => {
      const { first, second } = await endThenRestart();

      pending[0].resolve({ data: BOOTSTRAP });
      await first;
      expect(endCalls()).toHaveLength(0);

      pending[1].reject(conflict());
      await second;
      expect(useConversationalVoiceStore.getState().phase).toBe('error');
      expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
    });

    it('settles the superseded hold when the newer bootstrap fails before it resolves', async () => {
      const { first, second } = await endThenRestart();

      pending[1].reject(conflict());
      await second;
      expect(endCalls()).toHaveLength(0);

      pending[0].resolve({ data: BOOTSTRAP });
      await first;
      expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
    });

    it('settles the deferred hold when the newer call is ended before its bootstrap returns', async () => {
      const { first, second } = await endThenRestart();

      pending[0].resolve({ data: BOOTSTRAP });
      await first;
      await useConversationalVoiceStore.getState().end();
      expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);

      pending[1].reject(conflict());
      await second;
      expect(endCalls()).toHaveLength(1);
    });
  });

  it('settles a superseded fresh-notebook bootstrap even when a newer call has started', async () => {
    const resolvers: ((value: { data: typeof BOOTSTRAP }) => void)[] = [];
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions'
        ? new Promise(resolve => {
            resolvers.push(resolve);
          })
        : Promise.resolve({ data: {} })
    );

    const first = useConversationalVoiceStore.getState().start({});
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(1));
    await useConversationalVoiceStore.getState().end();
    const second = useConversationalVoiceStore.getState().start({});
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(2));

    resolvers[0]({ data: BOOTSTRAP });
    await first;
    expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);

    resolvers[1]({ data: { ...BOOTSTRAP, session: { id: 's2', name: 'Voice' } } });
    await second;
  });

  it('still settles a superseded bootstrap when the newer start fails its mic check', async () => {
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

    const first = useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    await vi.waitFor(() => expect(sessionCalls()).toHaveLength(1));
    await useConversationalVoiceStore.getState().end();
    getUserMedia.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NotAllowedError' }));
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    expect(useConversationalVoiceStore.getState().phase).toBe('error');

    resolveBootstrap({ data: BOOTSTRAP });
    await first;
    expect(endCalls().map(([url]) => url)).toEqual(['/api/voice/v2/sessions/s1/end']);
  });

  it('clears a pending reconnect timer when the first transport connect fails', async () => {
    vi.useFakeTimers();
    try {
      startSessionMock.mockImplementationOnce(async options => {
        capturedOptions = options;
        options.onDisconnect?.({ reason: 'error', message: 'drop', context: new Event('close') });
        throw new Error('websocket refused');
      });

      await useConversationalVoiceStore.getState().start({});
      expect(useConversationalVoiceStore.getState().phase).toBe('error');
      await vi.advanceTimersByTimeAsync(5000);

      expect(sessionCalls()).toHaveLength(1);
      expect(endCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useConversationalVoice - microphone permission preflight', () => {
  const query = vi.fn();

  beforeEach(() => {
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue(micStream());
    query.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ data: BOOTSTRAP });
  });

  afterEach(async () => {
    await useConversationalVoiceStore.getState().end();
    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
  });

  const withPermissions = (impl: () => Promise<{ state: string }>) => {
    query.mockImplementation(impl);
    Object.defineProperty(navigator, 'permissions', { value: { query }, configurable: true });
  };
  const sessionCalls = () => apiPost.mock.calls.filter(([url]) => url === '/api/voice/v2/sessions');

  it('skips the getUserMedia probe when permission is already granted', async () => {
    withPermissions(async () => ({ state: 'granted' }));
    await useConversationalVoiceStore.getState().start({});
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sessionCalls()).toHaveLength(1);
  });

  it('probes when the permission state is prompt', async () => {
    withPermissions(async () => ({ state: 'prompt' }));
    await useConversationalVoiceStore.getState().start({});
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(sessionCalls()).toHaveLength(1);
  });

  it('never bootstraps or probes when permission is denied', async () => {
    withPermissions(async () => ({ state: 'denied' }));
    await useConversationalVoiceStore.getState().start({});
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sessionCalls()).toHaveLength(0);
    expect(useConversationalVoiceStore.getState().errorMessage).toMatch(/Microphone access denied/);
  });

  it('probes when the permissions query throws or the API is absent', async () => {
    withPermissions(() => Promise.reject(new TypeError('unsupported')));
    await useConversationalVoiceStore.getState().start({});
    expect(getUserMedia).toHaveBeenCalledOnce();
    await useConversationalVoiceStore.getState().end();

    getUserMedia.mockClear();
    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
    await useConversationalVoiceStore.getState().start({});
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});
