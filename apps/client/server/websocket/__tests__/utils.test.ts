import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnauthorizedError } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { TokenExpiredError } from 'jsonwebtoken';
import type { Context } from 'aws-lambda';

vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'test', MONGODB_URI: 'mongodb://test' },
}));

import { withWebSocketContext } from '../utils';

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
