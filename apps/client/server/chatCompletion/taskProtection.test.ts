import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTaskProtection,
  MAX_REFRESHED_BUSY_MS,
  PROTECTION_EXPIRES_IN_MINUTES,
  PROTECTION_REFRESH_MS,
} from './taskProtection';

const AGENT_URI = 'http://169.254.170.2/api/task-id';
const ENABLE = { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_IN_MINUTES };
const DISABLE = { ProtectionEnabled: false };

const okResponse = () => new Response(JSON.stringify({ protection: { ProtectionEnabled: true } }), { status: 200 });
const failureResponse = () =>
  new Response(JSON.stringify({ failure: { Reason: 'TASK_NOT_VALID', Detail: 'nope' } }), { status: 200 });

const makeLogger = () => ({ info: vi.fn(), error: vi.fn() });

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
    const protection = createTaskProtection({ agentUri: undefined, logger: makeLogger(), fetchFn });

    protection.update(3);
    await protection.idle();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('arms protection with an expiry and a request timeout when work starts, and clears it when idle', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

    protection.update(1);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS - 1);
    protection.update(2);
    protection.update(5);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshes protection on a timer while one long quest keeps the task busy', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

    protection.update(1);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS);
    await protection.idle();
    vi.advanceTimersByTime(PROTECTION_REFRESH_MS);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE, ENABLE]);
  });

  it('refreshes on new work once a refresh is due', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

    protection.update(1);
    await protection.idle();
    vi.setSystemTime(Date.now() + PROTECTION_REFRESH_MS);
    protection.update(2);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE]);
  });

  it('stops refreshing once the task has been busy past the cap, and re-arms after it next goes idle', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn });

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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

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

  it('recovers after a timed-out (aborted) agent call and a non-2xx error', async () => {
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
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn });

    protection.update(1);
    await protection.idle();
    expect(logger.error.mock.calls[0][1]).toMatchObject({ enabled: true });

    protection.update(2);
    await protection.idle();
    protection.update(3);
    await protection.idle();

    expect(sentBodies(fetchFn)).toEqual([ENABLE, ENABLE, ENABLE]);
    expect(logger.info).toHaveBeenCalledWith('Task scale-in protection calls recovered', { enabled: true });
  });
});
