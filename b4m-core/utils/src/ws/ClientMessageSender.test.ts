import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sendToConnection: vi.fn() }));
vi.mock('./utils', () => ({ sendToConnection: mocks.sendToConnection }));

import { ClientMessageSender } from './ClientMessageSender';

describe('ClientMessageSender - failed sends', () => {
  const findByUserId = vi.fn();
  const deleteByConnectionId = vi.fn();
  const logger = { info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    findByUserId.mockResolvedValue([{ connectionId: 'c-gone' }, { connectionId: 'c-flaky' }]);
    deleteByConnectionId.mockResolvedValue(undefined);
  });

  it('deletes only the connection whose socket is gone', async () => {
    mocks.sendToConnection
      .mockRejectedValueOnce(new GoneException({ message: 'gone', $metadata: {} }))
      .mockRejectedValueOnce(new Error('throttled'));
    const sender = new ClientMessageSender({ connections: { findByUserId, deleteByConnectionId } }, logger as never);

    await sender.sendToClient('user-1', 'https://ws.example.com/test', { action: 'heartbeat' } as never);

    expect(deleteByConnectionId).toHaveBeenCalledTimes(1);
    expect(deleteByConnectionId).toHaveBeenCalledWith('c-gone');
  });
});
