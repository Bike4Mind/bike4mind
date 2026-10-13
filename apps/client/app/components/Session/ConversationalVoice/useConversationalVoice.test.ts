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
const getUserMediaMock = vi.fn();
const setMediaDevices = (value: unknown) =>
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true, writable: true });

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
    getUserMediaMock.mockReset();
    getUserMediaMock.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    setMediaDevices({ getUserMedia: getUserMediaMock });
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
    expect(endCalls().length).toBeGreaterThanOrEqual(1);
  });

  const sessionPosts = () => apiPost.mock.calls.filter(([url]) => url === '/api/voice/v2/sessions');

  it('releases the mic probe and proceeds on the happy path', async () => {
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(sessionPosts()).toHaveLength(1);
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    expect(endCalls()).toHaveLength(0);
  });

  it('does not create a session when the microphone is blocked', async () => {
    getUserMediaMock.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    const state = useConversationalVoiceStore.getState();
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toContain('Microphone access was blocked');
    expect(state.errorMessage).toContain('No credits were used.');
    expect(apiPost).not.toHaveBeenCalled();
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  it('does not create a session when no microphone is found', async () => {
    getUserMediaMock.mockRejectedValue(Object.assign(new Error('none'), { name: 'NotFoundError' }));
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    expect(useConversationalVoiceStore.getState().errorMessage).toContain('No microphone available');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('does not create a session when mediaDevices is unavailable', async () => {
    setMediaDevices(undefined);
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    const state = useConversationalVoiceStore.getState();
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toContain('No microphone available');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('refunds the hold when startSession throws after the session was created', async () => {
    startSessionMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'NotReadableError' }));
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(endCalls()).toEqual([['/api/voice/v2/sessions/s1/end', {}]]);
  });

  it('still surfaces the start error when the refund call itself fails', async () => {
    startSessionMock.mockRejectedValueOnce(new Error('boom'));
    apiPost.mockImplementation((url: string) =>
      url === '/api/voice/v2/sessions' ? Promise.resolve({ data: BOOTSTRAP }) : Promise.reject(new Error('net'))
    );
    await useConversationalVoiceStore.getState().start({ sessionId: 's1' });
    expect(useConversationalVoiceStore.getState().phase).toBe('error');
    expect(useConversationalVoiceStore.getState().errorMessage).toContain('boom');
  });
});
