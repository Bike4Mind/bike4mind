import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockResource = vi.hoisted(() => ({
  ChatCompletion: { url: 'http://chat-completion.internal' },
  CHAT_COMPLETION_INTERNAL_SECRET: { value: 'test-shared-secret' },
}));
vi.mock('sst', () => ({ Resource: mockResource }));

import { dispatchQuest } from './dispatchQuest';

// Minimal QuestStartBody - dispatchQuest only forwards it as the JSON body, so the exact
// shape doesn't matter here (the service validates it). Cast through unknown.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const params = { questId: 'q1', sessionId: 's1', userId: 'u1' } as any;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const res = (status: number, body = '') => ({ status, text: () => Promise.resolve(body) }) as Response;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('dispatchQuest', () => {
  it('resolves on a 202 ACK without retrying', async () => {
    fetchMock.mockResolvedValueOnce(res(202));
    await dispatchQuest(params, logger);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://chat-completion.internal/process');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-shared-secret');
  });

  it('does NOT retry on a 401 (deterministic auth failure)', async () => {
    fetchMock.mockResolvedValueOnce(res(401, 'Unauthorized'));
    await expect(dispatchQuest(params, logger)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a 400 (deterministic validation failure)', async () => {
    fetchMock.mockResolvedValueOnce(res(400, 'bad'));
    await expect(dispatchQuest(params, logger)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on a 5xx and succeeds on the second attempt', async () => {
    fetchMock.mockResolvedValueOnce(res(503, 'unavailable')).mockResolvedValueOnce(res(202));
    const promise = dispatchQuest(params, logger);
    await vi.advanceTimersByTimeAsync(500); // let the backoff elapse
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on a connection error and succeeds', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(res(202));
    const promise = dispatchQuest(params, logger);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting the single retry', async () => {
    fetchMock.mockResolvedValue(res(500, 'boom'));
    const promise = dispatchQuest(params, logger);
    const assertion = expect(promise).rejects.toThrow(/500/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
