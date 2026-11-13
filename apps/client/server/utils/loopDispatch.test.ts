import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  sendToQueue: vi.fn(),
  sendToClient: vi.fn(),
  resource: {} as Record<string, unknown>,
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: h.sendToClient }));
// A getter per key, like the SST shim: an unlinked resource throws on access.
vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get: (_target, key: string) => {
        if (!(key in h.resource)) throw new Error(`${key} is not linked`);
        return h.resource[key];
      },
    }
  ),
}));

import { pushLoopChanged, requestLoopDispatch } from './loopDispatch';

const logger = { warn: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  h.resource = { loopDispatchQueue: { url: 'q-url' }, websocket: { managementEndpoint: 'ws-endpoint' } };
});

describe('requestLoopDispatch', () => {
  it('sends the loop id to the dispatch queue', async () => {
    await requestLoopDispatch('l1', logger);
    expect(h.sendToQueue).toHaveBeenCalledWith('q-url', { loopId: 'l1' });
  });

  it('logs and swallows a send failure or a missing queue link', async () => {
    h.sendToQueue.mockRejectedValueOnce(new Error('throttled'));
    await expect(requestLoopDispatch('l1', logger)).resolves.toBeUndefined();

    h.resource = {};
    await expect(requestLoopDispatch('l1', logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('pushLoopChanged', () => {
  it("invalidates the loop's queries on the owner's open pages", async () => {
    await pushLoopChanged('u1', 'l1', logger);
    expect(h.sendToClient).toHaveBeenCalledWith('u1', 'ws-endpoint', {
      action: 'invalidate_query',
      queryKey: ['loops', 'l1'],
    });
  });

  it('logs and swallows a send failure', async () => {
    h.sendToClient.mockRejectedValueOnce(new Error('gone'));
    await expect(pushLoopChanged('u1', 'l1', logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
