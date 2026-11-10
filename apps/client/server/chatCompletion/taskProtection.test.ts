import { describe, expect, it, vi } from 'vitest';
import { createTaskProtection, PROTECTION_EXPIRES_IN_MINUTES } from './taskProtection';

const AGENT_URI = 'http://169.254.170.2/api/task-id';

const okResponse = () => new Response(JSON.stringify({ protection: { ProtectionEnabled: true } }), { status: 200 });

const makeLogger = () => ({ info: vi.fn(), error: vi.fn() });

const sentBodies = (fetchFn: ReturnType<typeof vi.fn>) =>
  fetchFn.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe('createTaskProtection', () => {
  it('is a no-op outside ECS (no agent URI)', async () => {
    const fetchFn = vi.fn();
    const protection = createTaskProtection({ agentUri: undefined, logger: makeLogger(), fetchFn });

    protection.update(3);
    await protection.idle();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('arms protection with an expiry when work starts and clears it when idle', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

    protection.update(1);
    await protection.idle();
    protection.update(0);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledWith(
      `${AGENT_URI}/task-protection/v1/state`,
      expect.objectContaining({ method: 'PUT' })
    );
    expect(sentBodies(fetchFn)).toEqual([
      { ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_IN_MINUTES },
      { ProtectionEnabled: false },
    ]);
  });

  it('does not re-arm while already busy', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

    protection.update(1);
    await protection.idle();
    protection.update(2);
    protection.update(5);
    await protection.idle();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('serializes calls and converges on the latest state after a busy -> idle -> busy flip', async () => {
    let releaseFirst: () => void = () => undefined;
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => (releaseFirst = () => resolve(okResponse()))))
      .mockImplementation(async () => okResponse());
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger: makeLogger(), fetchFn });

    protection.update(1);
    protection.update(0);
    protection.update(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    releaseFirst();
    await protection.idle();

    // The enable already applied matches the final desired state, so nothing more is sent.
    expect(sentBodies(fetchFn)).toEqual([{ ProtectionEnabled: true, ExpiresInMinutes: PROTECTION_EXPIRES_IN_MINUTES }]);
  });

  it('treats a 200 carrying a failure as a failure, logs once per streak and retries on the next update', async () => {
    const failure = () =>
      new Response(JSON.stringify({ failure: { Reason: 'TASK_NOT_VALID', Detail: 'nope' } }), { status: 200 });
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => failure())
      .mockImplementationOnce(async () => failure())
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

  it('surfaces a non-2xx agent error and a rejected fetch as failures', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: { Code: 'AccessDeniedException' } }), { status: 400 })
      )
      .mockImplementationOnce(async () => okResponse())
      .mockImplementationOnce(async () => {
        throw new Error('connect ECONNREFUSED');
      });
    const logger = makeLogger();
    const protection = createTaskProtection({ agentUri: AGENT_URI, logger, fetchFn });

    protection.update(1);
    await protection.idle();
    expect(logger.error.mock.calls[0][1]).toMatchObject({ error: 'AccessDeniedException' });

    protection.update(1);
    await protection.idle();
    protection.update(0);
    await protection.idle();
    expect(logger.error.mock.calls[1][1]).toMatchObject({ enabled: false, error: 'connect ECONNREFUSED' });
  });
});
