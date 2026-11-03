import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOneAndDelete = vi.fn();
const mockCountDocuments = vi.fn();
const mockUserUpdateOne = vi.fn();
const mockRemoveConnectionSubscribers = vi.fn();
const mockRemoveByConnectionId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  Connection: {
    findOneAndDelete: (...args: unknown[]) => ({ lean: async () => mockFindOneAndDelete(...args) }),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
  User: { updateOne: (...args: unknown[]) => mockUserUpdateOne(...args) },
  userRepository: {},
  realtimeConnectionRepository: {
    removeConnectionSubscribers: (...args: unknown[]) => mockRemoveConnectionSubscribers(...args),
  },
  activeCodeAgentRepository: { removeByConnectionId: (...args: unknown[]) => mockRemoveByConnectionId(...args) },
}));

const mockUpdateLogoutTime = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: { updateLogoutTime: (...args: unknown[]) => mockUpdateLogoutTime(...args) },
}));

vi.mock('@server/websocket/ccAgentHearth', () => ({ reportCcAgentPresence: vi.fn() }));

vi.mock('@bike4mind/server-utils/websocket/utils', () => ({
  sendToClient: vi.fn(),
  withWebSocketContext: (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler,
}));

import { func } from './disconnect';

const event = { requestContext: { connectionId: 'conn-1', domainName: 'ws.example.test', stage: 'dev' } };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const run = () => (func as unknown as (e: unknown, c: unknown, l: unknown) => Promise<unknown>)(event, {}, logger);

describe('$disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOneAndDelete.mockResolvedValue({ userId: 'user-1' });
    mockCountDocuments.mockResolvedValue(0);
    mockUserUpdateOne.mockResolvedValue({});
    mockUpdateLogoutTime.mockResolvedValue(undefined);
    mockRemoveConnectionSubscribers.mockResolvedValue(undefined);
    mockRemoveByConnectionId.mockResolvedValue([]);
  });

  it('removes the row and pulls its subscribers through the repository, which drops emptied docs', async () => {
    await expect(run()).resolves.toEqual({ statusCode: 200 });

    expect(mockFindOneAndDelete).toHaveBeenCalledWith({ connectionId: 'conn-1' });
    expect(mockRemoveConnectionSubscribers).toHaveBeenCalledWith('conn-1');
    expect(mockUpdateLogoutTime).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('still pulls the subscribers when the row is already gone', async () => {
    mockFindOneAndDelete.mockResolvedValue(null);

    await run();

    expect(mockRemoveConnectionSubscribers).toHaveBeenCalledWith('conn-1');
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockRemoveByConnectionId).not.toHaveBeenCalled();
  });

  it('logs and carries on when pulling the subscribers fails', async () => {
    mockRemoveConnectionSubscribers.mockRejectedValue(new Error('mongo down'));
    mockRemoveByConnectionId.mockResolvedValue([{ instanceId: 'i1', workspaceName: 'w', source: 's', deviceId: 'd' }]);

    await expect(run()).resolves.toEqual({ statusCode: 200 });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection subscribers'), expect.any(Error));
    expect(mockRemoveByConnectionId).toHaveBeenCalledWith('conn-1');
    expect(mockUpdateLogoutTime).toHaveBeenCalledWith('user-1', expect.anything());
  });
});
