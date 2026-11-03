import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectionRow: null as Record<string, unknown> | null,
  verifyClaims: vi.fn(),
  assertSessionActive: vi.fn(),
  endConnections: vi.fn(),
  deleteEndedConnections: vi.fn(),
  reauthenticate: vi.fn(),
  closeConnection: vi.fn(),
  sendToConnection: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  Connection: { findOne: vi.fn(() => ({ lean: async () => mocks.connectionRow })) },
  realtimeConnectionRepository: {
    endConnections: (...args: unknown[]) => mocks.endConnections(...args),
    deleteEndedConnections: (...args: unknown[]) => mocks.deleteEndedConnections(...args),
    reauthenticate: (...args: unknown[]) => mocks.reauthenticate(...args),
  },
}));
vi.mock('@server/websocket/verifyWsAccessToken', () => ({
  verifyWsAccessTokenClaims: (...args: unknown[]) => mocks.verifyClaims(...args),
}));
vi.mock('@server/websocket/realtimeSession', () => ({
  assertRealtimeSessionActive: (...args: unknown[]) => mocks.assertSessionActive(...args),
}));
vi.mock('@bike4mind/server-utils/websocket/closeConnection', () => ({
  closeConnection: (...args: unknown[]) => mocks.closeConnection(...args),
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({
  sendToConnection: (...args: unknown[]) => mocks.sendToConnection(...args),
  withWebSocketContext:
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) =>
    (event: unknown, context: unknown) =>
      handler(event, context, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.example.com/dev' } } }));

import { func } from './reauthConnection';

const ENDPOINT = 'https://ws.example.com/dev';
const EXPIRES_AT = new Date('2026-10-14T12:30:00.000Z');

const invoke = (connectionId = 'conn-1') =>
  (func as unknown as (event: unknown, context: unknown) => Promise<{ statusCode: number }>)(
    {
      requestContext: { connectionId },
      body: JSON.stringify({ action: 'reauth_connection', accessToken: 'fresh-jwt' }),
    },
    {}
  );

const claims = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'user-1' },
  sid: 'sid-1',
  tokenVersion: 3,
  expiresAt: EXPIRES_AT,
  ...overrides,
});

const expectConnectionEnded = (result: { statusCode: number }) => {
  expect(result.statusCode).toBe(401);
  expect(mocks.endConnections).toHaveBeenCalledWith({ connectionIds: ['conn-1'] });
  expect(mocks.closeConnection).toHaveBeenCalledWith('conn-1', ENDPOINT);
  expect(mocks.deleteEndedConnections).toHaveBeenCalledWith(['conn-1']);
  expect(mocks.reauthenticate).not.toHaveBeenCalled();
  expect(mocks.sendToConnection).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectionRow = { connectionId: 'conn-1', userId: 'user-1', sid: 'sid-1', tokenVersion: 3 };
  mocks.verifyClaims.mockResolvedValue(claims());
  mocks.assertSessionActive.mockResolvedValue(undefined);
  mocks.endConnections.mockResolvedValue({ connectionIds: ['conn-1'] });
  mocks.deleteEndedConnections.mockResolvedValue(1);
  mocks.reauthenticate.mockResolvedValue(true);
  mocks.closeConnection.mockResolvedValue(undefined);
  mocks.sendToConnection.mockResolvedValue(undefined);
});

describe('reauth_connection', () => {
  it('re-stamps the connection and asks the client to resubscribe for the same user and session', async () => {
    const result = await invoke();

    expect(result.statusCode).toBe(200);
    expect(mocks.verifyClaims).toHaveBeenCalledWith('fresh-jwt');
    expect(mocks.assertSessionActive).toHaveBeenCalledWith('sid-1');
    expect(mocks.reauthenticate).toHaveBeenCalledWith('conn-1', { tokenVersion: 3, authExpiresAt: EXPIRES_AT });
    expect(mocks.sendToConnection).toHaveBeenCalledWith('conn-1', ENDPOINT, { action: 'resubscribe_required' });
    expect(mocks.endConnections).not.toHaveBeenCalled();
  });

  it('binds the session to a connection that was recorded without one', async () => {
    mocks.connectionRow = { connectionId: 'conn-1', userId: 'user-1' };

    await invoke();

    expect(mocks.reauthenticate).toHaveBeenCalledWith('conn-1', {
      tokenVersion: 3,
      authExpiresAt: EXPIRES_AT,
      sid: 'sid-1',
    });
  });

  it('ends the connection when the token belongs to a different user', async () => {
    mocks.verifyClaims.mockResolvedValue(claims({ user: { id: 'user-2' } }));
    expectConnectionEnded(await invoke());
  });

  it('ends the connection when the token belongs to a different session', async () => {
    mocks.verifyClaims.mockResolvedValue(claims({ sid: 'sid-2' }));
    expectConnectionEnded(await invoke());
  });

  it('ends the connection when the token is rejected (stale tokenVersion)', async () => {
    mocks.verifyClaims.mockRejectedValue(new UnauthorizedError('Session expired'));
    expectConnectionEnded(await invoke());
  });

  it('ends the connection when the session is no longer active', async () => {
    mocks.assertSessionActive.mockRejectedValue(new UnauthorizedError('Session expired'));
    expectConnectionEnded(await invoke());
  });

  it('ends the connection when the session owes MFA enrollment', async () => {
    mocks.verifyClaims.mockRejectedValue(new ForbiddenError('MFA enrollment required.'));
    expectConnectionEnded(await invoke());
  });

  it('ends the connection when its row is gone', async () => {
    mocks.connectionRow = null;
    expectConnectionEnded(await invoke());
    expect(mocks.verifyClaims).not.toHaveBeenCalled();
  });

  it('ends an API-key connection instead of moving it onto a session token', async () => {
    mocks.connectionRow = { connectionId: 'conn-1', userId: 'user-1', apiKeyId: 'key-1' };
    expectConnectionEnded(await invoke());
  });

  it('still answers 401 when closing the socket fails', async () => {
    mocks.verifyClaims.mockResolvedValue(claims({ user: { id: 'user-2' } }));
    mocks.closeConnection.mockRejectedValue(new Error('network'));

    const result = await invoke();

    expect(result.statusCode).toBe(401);
    expect(mocks.endConnections).toHaveBeenCalledWith({ connectionIds: ['conn-1'] });
  });

  it('ends the connection when the row disappears between the checks and the update', async () => {
    mocks.reauthenticate.mockResolvedValue(false);

    const result = await invoke();

    expect(result.statusCode).toBe(401);
    expect(mocks.endConnections).toHaveBeenCalledWith({ connectionIds: ['conn-1'] });
    expect(mocks.sendToConnection).not.toHaveBeenCalled();
  });

  it('keeps the ended row for the sweep when closing the socket fails', async () => {
    mocks.verifyClaims.mockResolvedValue(claims({ user: { id: 'user-2' } }));
    mocks.closeConnection.mockRejectedValue(new Error('network'));

    await invoke();

    expect(mocks.deleteEndedConnections).not.toHaveBeenCalled();
  });

  it('propagates a failed lookup instead of refusing, leaving the connection as it was', async () => {
    mocks.verifyClaims.mockRejectedValue(new Error('connection timed out'));

    await expect(invoke()).rejects.toThrow('connection timed out');

    expect(mocks.endConnections).not.toHaveBeenCalled();
    expect(mocks.closeConnection).not.toHaveBeenCalled();
    expect(mocks.reauthenticate).not.toHaveBeenCalled();
  });

  it('propagates a failed session lookup instead of refusing', async () => {
    mocks.assertSessionActive.mockRejectedValue(new Error('connection timed out'));

    await expect(invoke()).rejects.toThrow('connection timed out');

    expect(mocks.endConnections).not.toHaveBeenCalled();
  });

  it('ends and closes the connection when resubscribe_required cannot be delivered', async () => {
    mocks.sendToConnection.mockRejectedValue(new Error('payload rejected'));

    const result = await invoke();

    expect(result.statusCode).toBe(500);
    expect(mocks.reauthenticate).toHaveBeenCalled();
    expect(mocks.endConnections).toHaveBeenCalledWith({ connectionIds: ['conn-1'] });
    expect(mocks.closeConnection).toHaveBeenCalledWith('conn-1', ENDPOINT);
  });

  it('leaves a gone socket to $disconnect when resubscribe_required hits a closed connection', async () => {
    mocks.sendToConnection.mockRejectedValue(new GoneException({ message: 'gone', $metadata: {} }));

    const result = await invoke();

    expect(result.statusCode).toBe(200);
    expect(mocks.endConnections).not.toHaveBeenCalled();
    expect(mocks.closeConnection).not.toHaveBeenCalled();
  });
});
