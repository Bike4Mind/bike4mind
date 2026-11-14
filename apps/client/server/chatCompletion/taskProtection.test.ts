import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTaskProtection,
  MAX_REFRESHED_BUSY_MS,
  PROTECTION_EXPIRES_IN_MINUTES,
  PROTECTION_REFRESH_MS,
  REFRESH_TOLERANCE_MS,
  TRANSIENT_RETRY_DELAY_MS,
} from './taskProtection';

const AGENT_URI = 'http://169.254.170.2/api/task-id';
const ENABLE = { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_IN_MINUTES };
const DISABLE = { ProtectionEnabled: false };

const okResponse = () => new Response(JSON.stringify({ protection: { ProtectionEnabled: true } }), { status: 200 });
const failureResponse = () =>
  new Response(JSON.stringify({ failure: { Reason: 'TASK_NOT_VALID', Detail: 'nope' } }), { status: 200 });

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const timeout = () => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};
const stoppingResponse = () =>
  new Response(JSON.stringify({ failure: { Reason: 'TASK_STOPPING_OR_STOPPED' } }), { status: 200 });

const sentBodies = (fetchFn: ReturnType<typeof vi.fn>) =>
  fetchFn.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

/** A fetch whose next call stays pending until `release()` is called. */
const heldOnce = () => {
  let release: () => void = () => undefined;
  const pending = new Promise<Response>(resolve => (release = () => resolve(okResponse())));
  return { pending, release: () => release() };
};

describe('createTaskProtection', () => {
  beforeEach(() => {
    // Promises and AbortSignal.timeout keep real timers; only the refresh interval and clock are faked.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op outside ECS (no agent URI)', async () => {
    const fetchFn = vi.fn();
    const protection = createTaskProtection({ agentUri: undefined, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(3);
    await protection.idle();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('arms protection with an expiry and a request timeout when work starts, and clears it when idle', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    protection.update(0);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledWith(
      `${AGENT_URI}/task-protection/v1/state`,
      expect.objectContaining({ method: 'PUT', signal: expect.any(AbortSignal) })
    );
    expect(sentBodies(fetchFn)).toEqual([ENABLE, DISABLE]);
  });

  it('does not call the agent again for more work arriving before a refresh is due', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS - REFRESH_TOLERANCE_MS - 1);
    protection.update(2);
    protection.update(5);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshes protection on a timer while one long quest keeps the task busy', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE, ENABLE]);
  });

  it('refreshes on every timer tick when the agent call takes time to return', async () => {
    const latencyMs = 250;
    const fetchFn = vi.fn().mockImplementation(async () => {
      // Yield first so the latency lands after the timer tick that issued the call has returned.
      await Promise.resolve();
      vi.advanceTimersByTime(latencyMs);
      return okResponse();
    });
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    // Each step stops the clock exactly on the next tick, as a real interval fires.
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS - latencyMs);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS - latencyMs);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE, ENABLE]);
  });

  it('refreshes on new work once a refresh is due', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    vi.setSystemTime(Date.now() + PROTECTION_REFRESH_MS);
    protection.update(2);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE]);
  });

  it('stops refreshing once the task has been busy past the cap, and re-arms after it next goes idle', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    for (let elapsed = 0; elapsed < MAX_REFRESHED_BUSY_MS * 2; elapsed += PROTECTION_REFRESH_MS) {
      vi.advanceTimersByTime(PROTECTION_REFRESH_MS);
      await protection.idle();
    }
    const enablesWhileBusy = sentBodies(fetchFn).length;
    // The first arm plus one refresh per interval strictly inside the cap.
    expect(enablesWhileBusy).toBe(MAX_REFRESHED_BUSY_MS / PROTECTION_REFRESH_MS);

    protection.update(0);
    await protection.idle();
    protection.update(1);
    await protection.idle();

    expect(sentBodies(fetchFn).slice(enablesWhileBusy)).toEqual([DISABLE, ENABLE]);
  });

  it('applies a disable that arrived while the enable was in flight', async () => {
    const held = heldOnce();
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => held.pending)
      .mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    protection.update(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    held.release();
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, DISABLE]);
  });

  it('re-enables when new work arrives while a disable is in flight', async () => {
    const held = heldOnce();
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => okResponse())
      .mockImplementationOnce(() => held.pending)
      .mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    protection.update(0);
    protection.update(1);

    held.release();
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, DISABLE, ENABLE]);
  });

  it('sends nothing more when a busy -> idle -> busy flip ends where the in-flight call lands', async () => {
    const held = heldOnce();
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => held.pending)
      .mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    protection.update(0);
    protection.update(1);
    held.release();
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE]);
  });

  it('treats a 200 carrying a failure as a failure, logs once per streak and retries on the next update', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => failureResponse())
      .mockImplementationOnce(async () => failureResponse())
      .mockImplementation(async () => okResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    protection.update(2);
    await protection.idle();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ enabled: true, error: 'TASK_NOT_VALID: nope' });

    protection.update(3);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith('Task scale-in protection calls recovered', { enabled: true });
  });

  it('retries a failed enable on the timer while one quest keeps the count unchanged', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => failureResponse())
      .mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE]);
  });

  it('retries a failed disable on the timer so an idle task does not stay protected', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => okResponse())
      .mockImplementationOnce(async () => failureResponse())
      .mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    protection.update(0);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, DISABLE, DISABLE]);

    // Converged and idle: the timer is gone, so nothing more is sent.
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS * 3);
    await protection.idle();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('logs a fatal error from the retry after a timeout, then recovers on the next update', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      })
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: { Code: 'AccessDeniedException' } }), { status: 400 })
      )
      .mockImplementation(async () => okResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ enabled: true, error: 'AccessDeniedException' });

    protection.update(2);
    await protection.idle();
    protection.update(3);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE, ENABLE]);
    expect(logger.info).toHaveBeenCalledWith('Task scale-in protection calls recovered', { enabled: true });
  });

  it('re-sends enable after a disable that failed but may have taken effect', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => okResponse())
      .mockImplementationOnce(async () => timeout())
      .mockImplementationOnce(async () => timeout())
      .mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    protection.update(0);
    await protection.idle();
    protection.update(1);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, DISABLE, DISABLE, ENABLE]);
  });

  it('retries a timed-out call once and stays quiet when the retry succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => timeout())
      .mockImplementation(async () => okResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    // Applied: more work before a refresh is due sends nothing.
    protection.update(2);
    await protection.idle();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 5xx', () => new Response('{}', { status: 503 })],
    ['a 429', () => new Response('{}', { status: 429 })],
    [
      'a ServerException error',
      () => new Response(JSON.stringify({ error: { Code: 'ServerException' } }), { status: 400 }),
    ],
    [
      'a throttling failure body',
      () => new Response(JSON.stringify({ failure: { Reason: 'ThrottlingException' } }), { status: 200 }),
    ],
    ['throttling', () => new Response(JSON.stringify({ error: { Code: 'ThrottlingException' } }), { status: 400 })],
  ])('retries %s response once', async (_label, transientResponse) => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => transientResponse())
      .mockImplementation(async () => okResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs at warn, not error, when the retry also fails transiently, and recovers on the next update', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => timeout())
      .mockImplementationOnce(async () => timeout())
      .mockImplementation(async () => okResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      enabled: true,
      error: 'The operation was aborted due to timeout',
    });

    protection.update(2);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE, ENABLE]);
    expect(logger.info).toHaveBeenCalledWith('Task scale-in protection calls recovered', { enabled: true });
  });

  it('does not retry a non-transient failure within the same call', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ error: { Code: 'AccessDeniedException' } }), { status: 400 })
      );
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ enabled: true, error: 'AccessDeniedException' });
  });

  it('logs a stopping task at warn and makes no further agent calls', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => stoppingResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ enabled: true, error: 'TASK_STOPPING_OR_STOPPED' });
    expect(vi.getTimerCount()).toBe(0);

    protection.update(0);
    protection.update(1);
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS * 3);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('still logs a fatal failure at error after a transient failure already logged at warn', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => timeout())
      .mockImplementationOnce(async () => timeout())
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: { Code: 'AccessDeniedException' } }), { status: 400 })
      )
      .mockImplementation(async () => okResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    protection.update(2);
    await protection.idle();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({ error: 'AccessDeniedException' });

    // Same kind again in the same streak stays quiet.
    protection.update(3);
    await protection.idle();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs a stopping notice that arrives on the retry attempt', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => timeout())
      .mockImplementation(async () => stoppingResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ error: 'TASK_STOPPING_OR_STOPPED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a stopping notice that arrives during an existing failure streak', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => failureResponse())
      .mockImplementation(async () => stoppingResponse());
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();
    expect(logger.error).toHaveBeenCalledTimes(1);

    protection.update(2);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ error: 'TASK_STOPPING_OR_STOPPED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a stopping code on a non-2xx response as stopping', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ error: { Code: 'TASK_STOPPING_OR_STOPPED' } }), { status: 400 })
      );
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn, retryDelayMs: 0 });

    protection.update(1);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  describe('retry delay', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });

    it('waits the default delay before the retry', async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () => timeout())
        .mockImplementation(async () => okResponse());
      const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

      protection.update(1);
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS - 1);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await protection.idle();
      expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE]);
    });

    it('sends the latest desired state after the wait when it flipped meanwhile', async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () => timeout())
        .mockImplementation(async () => okResponse());
      const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

      protection.update(1);
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS / 2);
      protection.update(0);
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAY_MS);
      await protection.idle();

      expect(sentBodies(fetchFn)).toEqual([ENABLE, DISABLE]);
    });
  });
});
