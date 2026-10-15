import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnauthorizedError } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { JsonWebTokenError, NotBeforeError, TokenExpiredError } from 'jsonwebtoken';
import type { Context } from 'aws-lambda';

const sendToClientMocks = vi.hoisted(() => ({
  find: vi.fn(),
  deleteOne: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@bike4mind/database/social', () => ({
  Connection: { find: sendToClientMocks.find, deleteOne: sendToClientMocks.deleteOne },
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', async importOriginal => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-apigatewaymanagementapi')>()),
  ApiGatewayManagementApiClient: class {
    send = sendToClientMocks.send;
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'test', MONGODB_URI: 'mongodb://test' },
}));

import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { sendToClient, withWebSocketContext } from '../utils';

const mockContext = { functionName: 'test-fn', awsRequestId: 'req-1', functionVersion: '1' } as Context;

describe('withWebSocketContext - auth-error detection', () => {
  it('returns 401 when the handler throws UnauthorizedError (the connect.ts rejection path)', async () => {
    const handler = withWebSocketContext(
      async () => {
        throw new UnauthorizedError('Session expired');
      },
      { skipDatabase: true }
    );

    const result = await handler({} as never, mockContext);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a message whose text does not contain "unauthorized" - the bug this fixes', async () => {
    // Before the fix, isAuthError sniffed error.message for the substring "unauthorized".
    // connect.ts throws UnauthorizedError with caller-supplied messages like 'Session expired'
    // and 'User not found' that never contain it, so every WS auth rejection fell through to
    // the 200/zombie branch below. Detecting by type closes that gap regardless of message text.
    const handler = withWebSocketContext(
      async () => {
        throw new UnauthorizedError('User not found');
      },
      { skipDatabase: true }
    );

    const result = await handler({} as never, mockContext);

    expect(result.statusCode).toBe(401);
  });

  it('returns 401 for a raw TokenExpiredError (dataSubscribeRequest/dataUnsubscribeRequest call verifyToken with no local try/catch)', async () => {
    const handler = withWebSocketContext(
      async () => {
        throw new TokenExpiredError('jwt expired', new Date());
      },
      { skipDatabase: true }
    );

    const result = await handler({} as never, mockContext);

    expect(result.statusCode).toBe(401);
  });

  it('returns 401 for a raw JsonWebTokenError - a forged/invalid-signature token (matched via the base class)', async () => {
    // verifyToken re-throws the raw jwt error; an invalid signature is a JsonWebTokenError,
    // not a TokenExpiredError, so it must still be treated as an auth rejection (401), not a
    // transient 200/zombie.
    const handler = withWebSocketContext(
      async () => {
        throw new JsonWebTokenError('invalid signature');
      },
      { skipDatabase: true }
    );

    const result = await handler({} as never, mockContext);

    expect(result.statusCode).toBe(401);
  });

  it('returns 401 for a raw NotBeforeError - a not-yet-valid token (also a JsonWebTokenError subclass)', async () => {
    const handler = withWebSocketContext(
      async () => {
        throw new NotBeforeError('jwt not active', new Date());
      },
      { skipDatabase: true }
    );

    const result = await handler({} as never, mockContext);

    expect(result.statusCode).toBe(401);
  });

  it('preserves 200 for a non-auth error, so an established connection is not dropped', async () => {
    const handler = withWebSocketContext(
      async () => {
        throw new Error('boom');
      },
      { skipDatabase: true }
    );

    const result = await handler({} as never, mockContext);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ error: 'Internal server error' });
  });

  it('passes through the handler result unchanged on success', async () => {
    const handler = withWebSocketContext(async () => ({ statusCode: 200, body: 'ok' }), { skipDatabase: true });

    const result = await handler({} as never, mockContext);

    expect(result).toEqual({ statusCode: 200, body: 'ok' });
  });

  describe('log level', () => {
    // withWebSocketContext does `new Logger().withMetadata(...)`, and withMetadata returns a
    // fresh Logger, so the info/error calls resolve through Logger.prototype - spy there.
    let infoSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
      errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('logs an auth rejection at info, not error (stale-token clients are high-volume and benign)', async () => {
      const handler = withWebSocketContext(
        async () => {
          throw new UnauthorizedError('Session expired');
        },
        { skipDatabase: true }
      );

      await handler({} as never, mockContext);

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs a genuine (non-auth) handler failure at error', async () => {
      const handler = withWebSocketContext(
        async () => {
          throw new Error('boom');
        },
        { skipDatabase: true }
      );

      await handler({} as never, mockContext);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).not.toHaveBeenCalled();
    });
  });
});

describe('sendToClient - which failed sends delete a connection row', () => {
  const message = { action: 'heartbeat' } as never;

  beforeEach(() => {
    sendToClientMocks.find.mockReset();
    sendToClientMocks.deleteOne.mockReset();
    sendToClientMocks.send.mockReset();
    sendToClientMocks.find.mockResolvedValue([{ connectionId: 'c-gone' }, { connectionId: 'c-flaky' }]);
    sendToClientMocks.deleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  it('deletes the row of a gone socket and keeps the row of one that failed for another reason', async () => {
    sendToClientMocks.send
      .mockRejectedValueOnce(new GoneException({ message: 'gone', $metadata: {} }))
      .mockRejectedValueOnce(new Error('throttled'));

    await sendToClient('user-1', 'https://ws.example.com/test', message);

    expect(sendToClientMocks.deleteOne).toHaveBeenCalledTimes(1);
    expect(sendToClientMocks.deleteOne).toHaveBeenCalledWith({ connectionId: 'c-gone' });
  });

  it('deletes nothing when every send succeeds', async () => {
    sendToClientMocks.send.mockResolvedValue({});

    await sendToClient('user-1', 'https://ws.example.com/test', message);

    expect(sendToClientMocks.deleteOne).not.toHaveBeenCalled();
  });
});
