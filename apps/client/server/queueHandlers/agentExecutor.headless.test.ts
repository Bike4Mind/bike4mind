/**
 * The two branches that make a run with no WebSocket peer work at all.
 *
 * Both turn on one `isHeadlessConnection(connectionId)` call, and both fix failures CI
 * could not see: without the sender short-circuit every step fires a doomed
 * `PostToConnection` that this sender swallows, and without the permission short-circuit
 * a REST run parks in `awaiting_permission` until the 20-minute stale sweep, holding one
 * of the caller's three concurrency slots with no client able to send
 * `permission_response`. A refactor that stops threading the sentinel through would
 * reintroduce both with the rest of the suite green, so they are pinned here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HEADLESS_CONNECTION_ID } from '@server/utils/headlessConnection';
import { resolveGateDisposition } from './agentExecutorUtils/toolPermissions';

const postToConnection = vi.fn().mockResolvedValue({});

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : `mock-${String(key)}`) }),
  }),
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send(command: unknown) {
      return postToConnection(command);
    }
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createWsSender on a headless run', () => {
  it('never posts to a connection, so a headless step does not fire a doomed send', async () => {
    const { createWsSender } = await import('./agentExecutor');

    const send = createWsSender(HEADLESS_CONNECTION_ID, logger as never);
    await send('iteration_step', { executionId: 'exec1' });
    await send('completed', { executionId: 'exec1' });

    expect(postToConnection).not.toHaveBeenCalled();
    // One log line, so "no events streamed" stays distinguishable from "events were
    // sent and dropped" - the sender swallows real send errors.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Headless execution'));
  });

  it('still posts for a real connection id', async () => {
    const { createWsSender } = await import('./agentExecutor');

    const send = createWsSender('conn-1', logger as never);
    await send('iteration_step', { executionId: 'exec1' });

    expect(postToConnection).toHaveBeenCalledTimes(1);
  });
});

describe('resolveGateDisposition', () => {
  it('fails a headless run that reaches an approval-gated tool instead of pausing forever', () => {
    expect(resolveGateDisposition('needs_approval', HEADLESS_CONNECTION_ID)).toBe('no_approver');
  });

  it('still pauses and asks when there is a client that can answer', () => {
    expect(resolveGateDisposition('needs_approval', 'conn-1')).toBe('ask');
  });

  it('keeps an explicit denial a denial on both transports', () => {
    expect(resolveGateDisposition('denied', HEADLESS_CONNECTION_ID)).toBe('denied');
    expect(resolveGateDisposition('denied', 'conn-1')).toBe('denied');
  });
});
