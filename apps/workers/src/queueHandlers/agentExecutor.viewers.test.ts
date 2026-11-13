/**
 * Viewer fan-out in `createWsSender`: a connection that `subscribe`d to an execution gets every frame
 * the owner connection gets, including on a headless run that has no owner connection at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
import { agentExecutionRepository } from '@bike4mind/database';
import { HEADLESS_CONNECTION_ID } from '@bike4mind/server-utils/utils/headlessConnection';

const postToConnection = vi.fn();

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : `mock-${String(key)}`) }),
  }),
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send(command: { input: { ConnectionId: string } }) {
      return postToConnection(command.input.ConnectionId);
    }
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const findViewers = vi.spyOn(agentExecutionRepository, 'findViewerConnectionIds');
const removeViewer = vi.spyOn(agentExecutionRepository, 'removeViewer');

const targetsOf = () => postToConnection.mock.calls.map(([id]) => id).sort();

beforeEach(() => {
  vi.clearAllMocks();
  postToConnection.mockResolvedValue({});
  findViewers.mockResolvedValue(['viewer-1', 'viewer-2']);
  removeViewer.mockResolvedValue();
});

describe('createWsSender with viewers', () => {
  it('sends each frame to the owner connection and every viewer', async () => {
    const { createWsSender } = await import('./agentExecutor');
    await createWsSender('conn-1', logger as never, 'exec1')('iteration_step', { executionId: 'exec1' });
    expect(targetsOf()).toEqual(['conn-1', 'viewer-1', 'viewer-2']);
  });

  it('streams a headless run to its viewers only', async () => {
    const { createWsSender } = await import('./agentExecutor');
    await createWsSender(HEADLESS_CONNECTION_ID, logger as never, 'exec1')('completed', { executionId: 'exec1' });
    expect(targetsOf()).toEqual(['viewer-1', 'viewer-2']);
  });

  it('does not double-send to a viewer that is also the owner connection', async () => {
    findViewers.mockResolvedValue(['conn-1', 'viewer-1']);
    const { createWsSender } = await import('./agentExecutor');
    await createWsSender('conn-1', logger as never, 'exec1')('agent_text_delta', { executionId: 'exec1' });
    expect(targetsOf()).toEqual(['conn-1', 'viewer-1']);
  });

  it('drops a gone viewer and still delivers to the others', async () => {
    postToConnection.mockImplementation(async (id: string) => {
      if (id === 'viewer-1') throw Object.assign(new Error('gone'), { name: 'GoneException' });
      return {};
    });
    const { createWsSender } = await import('./agentExecutor');
    const send = createWsSender('conn-1', logger as never, 'exec1');
    await send('agent_text_delta', { executionId: 'exec1' });
    expect(removeViewer).toHaveBeenCalledWith('exec1', 'viewer-1');
    expect(targetsOf()).toEqual(['conn-1', 'viewer-1', 'viewer-2']);

    postToConnection.mockClear();
    await send('agent_text_delta', { executionId: 'exec1' });
    expect(targetsOf()).toEqual(['conn-1', 'viewer-2']);
  });

  it('caches the viewer list for text deltas but re-reads it before an iteration step', async () => {
    const { createWsSender } = await import('./agentExecutor');
    const send = createWsSender('conn-1', logger as never, 'exec1');
    await send('agent_text_delta', {});
    await send('agent_text_delta', {});
    await send('progress', {});
    expect(findViewers).toHaveBeenCalledTimes(1);
    await send('iteration_step', {});
    expect(findViewers).toHaveBeenCalledTimes(2);
    await send('confidence_gate', {});
    expect(findViewers).toHaveBeenCalledTimes(3);
  });

  it('posts to the owner before the viewer read settles, and shares one read per tick', async () => {
    let settle: (ids: string[]) => void = () => {};
    findViewers.mockReturnValueOnce(new Promise(resolve => (settle = resolve)));
    const { createWsSender } = await import('./agentExecutor');
    const send = createWsSender('conn-1', logger as never, 'exec1');
    const first = send('iteration_step', {});
    const second = send('iteration_step', {});
    expect(targetsOf()).toEqual(['conn-1', 'conn-1']);
    settle(['viewer-1']);
    await Promise.all([first, second]);
    expect(findViewers).toHaveBeenCalledTimes(1);
    expect(targetsOf()).toEqual(['conn-1', 'conn-1', 'viewer-1', 'viewer-1']);
  });

  it('keeps the last viewer list when the read fails', async () => {
    const { createWsSender } = await import('./agentExecutor');
    const send = createWsSender('conn-1', logger as never, 'exec1');
    await send('iteration_step', {});
    findViewers.mockRejectedValueOnce(new Error('db down'));
    postToConnection.mockClear();
    await send('iteration_step', {});
    expect(targetsOf()).toEqual(['conn-1', 'viewer-1', 'viewer-2']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never removes the owner connection as a viewer when it is gone', async () => {
    postToConnection.mockImplementation(async (id: string) => {
      if (id === 'conn-1') throw Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 410 } });
      return {};
    });
    const { createWsSender } = await import('./agentExecutor');
    await createWsSender('conn-1', logger as never, 'exec1')('iteration_step', {});
    expect(removeViewer).not.toHaveBeenCalled();
  });

  it('fans child frames out to the viewers of the root execution it was built with', async () => {
    const { createWsSender } = await import('./agentExecutor');
    await createWsSender(
      'conn-1',
      logger as never,
      'root-exec'
    )('subagent_iteration_step', {
      executionId: 'parent-exec',
      childExecutionId: 'child-exec',
    });
    expect(findViewers).toHaveBeenCalledWith('root-exec');
    expect(targetsOf()).toEqual(['conn-1', 'viewer-1', 'viewer-2']);
  });

  it('never reads viewers without a viewer execution id', async () => {
    const { createWsSender } = await import('./agentExecutor');
    await createWsSender('conn-1', logger as never)('iteration_step', {});
    expect(findViewers).not.toHaveBeenCalled();
    expect(targetsOf()).toEqual(['conn-1']);
  });
});
