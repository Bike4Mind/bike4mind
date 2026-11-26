import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dropUserSubscriptions, endConnections, closeConnection, sendToConnection } = vi.hoisted(() => ({
  dropUserSubscriptions: vi.fn(),
  endConnections: vi.fn(),
  closeConnection: vi.fn(),
  sendToConnection: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  realtimeConnectionRepository: { dropUserSubscriptions, endConnections },
}));
vi.mock('@bike4mind/server-utils/websocket/closeConnection', () => ({ closeConnection }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToConnection }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.example.com/dev' } } }));

import { rescopeUserSubscriptions } from './rescopeUserSubscriptions';

const logger = { warn: vi.fn() } as never;

describe('rescopeUserSubscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endConnections.mockResolvedValue({ connectionIds: [] });
    closeConnection.mockResolvedValue(undefined);
  });

  it('drops the users subscriptions once and tells each socket to re-subscribe', async () => {
    dropUserSubscriptions.mockResolvedValue(['c1', 'c2']);
    sendToConnection.mockResolvedValue(undefined);

    await rescopeUserSubscriptions(['u1', 'u1', 'u2'], logger);

    expect(dropUserSubscriptions).toHaveBeenCalledWith(['u1', 'u2']);
    expect(sendToConnection).toHaveBeenCalledWith('c1', 'https://ws.example.com/dev', {
      action: 'resubscribe_required',
    });
    expect(sendToConnection).toHaveBeenCalledWith('c2', 'https://ws.example.com/dev', {
      action: 'resubscribe_required',
    });
    expect(closeConnection).not.toHaveBeenCalled();
  });

  it('ends a socket it cannot notify, but ignores one already gone', async () => {
    dropUserSubscriptions.mockResolvedValue(['gone', 'broken']);
    sendToConnection.mockImplementation(async (connectionId: string) => {
      if (connectionId === 'gone') throw new GoneException({ message: 'gone', $metadata: {} });
      throw new Error('boom');
    });

    await rescopeUserSubscriptions(['u1'], logger);

    expect(endConnections).toHaveBeenCalledWith({ connectionIds: ['broken'] });
    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(closeConnection).toHaveBeenCalledWith('broken', 'https://ws.example.com/dev');
  });

  it('never throws and does nothing for no users', async () => {
    await rescopeUserSubscriptions([], logger);
    expect(dropUserSubscriptions).not.toHaveBeenCalled();

    dropUserSubscriptions.mockRejectedValue(new Error('db down'));
    await expect(rescopeUserSubscriptions(['u1'], logger)).resolves.toBeUndefined();
  });
});
