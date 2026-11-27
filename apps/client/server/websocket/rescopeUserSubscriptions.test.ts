import { beforeEach, describe, expect, it, vi } from 'vitest';

const { endConnections, deleteEndedConnections, closeConnection, dropUserSubscriptions, sendToConnection } = vi.hoisted(
  () => ({
    endConnections: vi.fn(),
    deleteEndedConnections: vi.fn(),
    closeConnection: vi.fn(),
    dropUserSubscriptions: vi.fn().mockResolvedValue(['old-connection']),
    sendToConnection: vi.fn().mockResolvedValue(undefined),
  })
);
vi.mock('@bike4mind/database', () => ({
  realtimeConnectionRepository: { endConnections, deleteEndedConnections, dropUserSubscriptions },
}));
vi.mock('@bike4mind/server-utils/websocket/closeConnection', () => ({ closeConnection }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToConnection }));
const resource = vi.hoisted(() => ({
  websocket: { managementEndpoint: 'https://ws.example.com/dev' } as { managementEndpoint: string } | undefined,
}));
vi.mock('sst', () => ({ Resource: resource }));
import { rescopeUserSubscriptions } from './rescopeUserSubscriptions';
const logger = { warn: vi.fn() } as never;

describe('rescopeUserSubscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endConnections.mockReset().mockResolvedValue({ connectionIds: [] });
    deleteEndedConnections.mockReset().mockResolvedValue(1);
    closeConnection.mockReset().mockResolvedValue(undefined);
    resource.websocket = { managementEndpoint: 'https://ws.example.com/dev' };
  });

  it('ends distinct users before closing each distinct socket and removing its ended row', async () => {
    endConnections.mockImplementation(async ({ userId }: { userId: string }) => ({
      connectionIds: [userId, 'common'],
    }));
    await rescopeUserSubscriptions(['u1', 'u1', 'u2'], logger);
    expect(endConnections.mock.calls).toEqual([[{ userId: 'u1' }], [{ userId: 'u2' }]]);
    expect(closeConnection).toHaveBeenCalledTimes(3);
    for (const id of ['u1', 'u2', 'common']) {
      expect(closeConnection).toHaveBeenCalledWith(id, 'https://ws.example.com/dev');
      expect(deleteEndedConnections).toHaveBeenCalledWith([id]);
    }
    expect(Math.max(...endConnections.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...closeConnection.mock.invocationCallOrder)
    );
  });

  it('waits for the database phase before any socket close', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    endConnections.mockImplementation(async ({ userId }: { userId: string }) => {
      if (userId === 'u1') await held;
      return { connectionIds: [userId] };
    });
    const pending = rescopeUserSubscriptions(['u1', 'u2'], logger);
    try {
      await vi.waitFor(() => expect(endConnections).toHaveBeenCalledTimes(2));
      expect(closeConnection).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(closeConnection).toHaveBeenCalledTimes(2);
  });

  it('retains ended rows when a close fails', async () => {
    endConnections.mockResolvedValue({ connectionIds: ['closed', 'retry'] });
    closeConnection.mockImplementation(async (id: string) => {
      if (id === 'retry') throw new Error('transport failed');
    });
    await expect(rescopeUserSubscriptions(['u1'], logger)).resolves.toBeUndefined();
    expect(deleteEndedConnections.mock.calls).toEqual([[['closed']]]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still ends rows when the websocket resource is not linked', async () => {
    resource.websocket = undefined;
    endConnections.mockResolvedValue({ connectionIds: ['c1'] });
    await expect(rescopeUserSubscriptions(['u1'], logger)).resolves.toBeUndefined();
    expect(endConnections).toHaveBeenCalledWith({ userId: 'u1' });
    expect(closeConnection).not.toHaveBeenCalled();
    expect(deleteEndedConnections).not.toHaveBeenCalled();
  });

  it('attempts other users when one database operation fails', async () => {
    endConnections.mockImplementation(async ({ userId }: { userId: string }) => {
      if (userId === 'u1') throw new Error('database failed');
      return { connectionIds: ['c2'] };
    });
    await expect(rescopeUserSubscriptions(['u1', 'u2'], logger)).resolves.toBeUndefined();
    expect(closeConnection).toHaveBeenCalledWith('c2', 'https://ws.example.com/dev');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does nothing for no users', async () => {
    await rescopeUserSubscriptions([], logger);
    expect(endConnections).not.toHaveBeenCalled();
    expect(closeConnection).not.toHaveBeenCalled();
  });
});
