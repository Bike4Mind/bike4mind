import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Same next-connect stand-in as sessions/[id]/chat/[messageId]/__tests__/index.redaction.test.ts:
// .get/.put/.delete each return the composed handler, and .use middleware runs first.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    chain.put = compose;
    chain.delete = compose;
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: <T>(fn: T) => fn,
}));

const mockFindSession = vi.fn();
const mockFindMessage = vi.fn();
const txn = vi.hoisted(() => ({ active: false }));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findByIdAndUserId: (...a: unknown[]) => mockFindSession(...a),
    update: vi.fn().mockResolvedValue(undefined),
  },
  questRepository: { findBySessionIdAndId: (...a: unknown[]) => mockFindMessage(...a) },
  withTransaction: async <T>(fn: () => Promise<T>) => {
    txn.active = true;
    try {
      return await fn();
    } finally {
      txn.active = false;
    }
  },
}));

const mockDeleteSessionMessage = vi.fn();
vi.mock('@bike4mind/services', () => ({
  sessionService: { deleteSessionMessage: (...a: unknown[]) => mockDeleteSessionMessage(...a) },
}));

const mockUnpublish = vi.fn();
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({
  unpublishUserArtifactsBySource: (...a: unknown[]) => mockUnpublish(...a),
}));

const mockPurgeMedia = vi.fn();
const purgeCalledInTxn = vi.hoisted(() => ({ value: false }));
vi.mock('@server/sessions/purgeDeletedMessageMedia', () => ({
  purgeDeletedMessageMedia: (...a: unknown[]) => {
    if (txn.active) purgeCalledInTxn.value = true;
    return mockPurgeMedia(...a);
  },
}));

import handler from '@pages/api/v1/sessions/[id]/messages/[messageId]';
import spaHandler from '@pages/api/sessions/[id]/chat/[messageId]';

// The URL id is matched case-insensitively upstream; the stored message carries the canonical one.
function fireDelete() {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'SESS-1', messageId: 'quest-1' } });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  Object.assign(req, { user: { id: 'owner-1' }, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  return { req: req as any, res: res as any, logger };
}

const replySource = { kind: 'replyMessage', sessionId: 'sess-1', messageIds: ['quest-1'] };

describe('DELETE /api/v1/sessions/[id]/messages/[messageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSession.mockResolvedValue({ id: 'sess-1' });
    mockFindMessage.mockResolvedValue({ id: 'quest-1', sessionId: 'sess-1' });
    mockDeleteSessionMessage.mockResolvedValue({ id: 'quest-1', sessionId: 'sess-1' });
    mockUnpublish.mockResolvedValue({ artifacts: [], annotations: 0, reports: 0, viewAudits: 0 });
    mockPurgeMedia.mockResolvedValue(undefined);
    purgeCalledInTxn.value = false;
  });

  it("takes down the caller's replies before the delete and sweeps again after it commits", async () => {
    const { req, res, logger } = fireDelete();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ msg: 'Message deleted' });
    expect(mockFindSession).toHaveBeenCalledWith('SESS-1', 'owner-1');
    expect(mockFindMessage).toHaveBeenCalledWith('sess-1', 'quest-1');
    expect(mockDeleteSessionMessage).toHaveBeenCalledWith(
      'owner-1',
      { sessionId: 'SESS-1', messageId: 'quest-1' },
      expect.anything()
    );
    expect(mockUnpublish).toHaveBeenCalledTimes(2);
    expect(mockUnpublish).toHaveBeenNthCalledWith(1, 'owner-1', replySource, { logger });
    expect(mockUnpublish).toHaveBeenNthCalledWith(2, 'owner-1', replySource, { logger });
    const [before, after] = mockUnpublish.mock.invocationCallOrder;
    const deleteOrder = mockDeleteSessionMessage.mock.invocationCallOrder[0];
    expect(before).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(after);
  });

  it('fails without deleting when the take-down fails, so a retry can finish the job', async () => {
    const failure = new Error('db down');
    mockUnpublish.mockRejectedValueOnce(failure);
    const { req, res } = fireDelete();

    await expect(handler(req, res)).rejects.toBe(failure);
    expect(mockDeleteSessionMessage).not.toHaveBeenCalled();
  });

  it('takes nothing down when the caller does not own the session', async () => {
    mockFindSession.mockResolvedValue(null);
    mockDeleteSessionMessage.mockRejectedValue(Object.assign(new Error('Session not found'), { statusCode: 404 }));
    const { req, res } = fireDelete();

    await expect(handler(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockFindMessage).not.toHaveBeenCalled();
    expect(mockUnpublish).not.toHaveBeenCalled();
    expect(mockPurgeMedia).not.toHaveBeenCalled();
  });

  it('takes nothing down when the message is missing or already deleted', async () => {
    mockFindMessage.mockResolvedValue(null);
    mockDeleteSessionMessage.mockRejectedValue(Object.assign(new Error('Message not found'), { statusCode: 404 }));
    const { req, res } = fireDelete();

    await expect(handler(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockUnpublish).not.toHaveBeenCalled();
    expect(mockPurgeMedia).not.toHaveBeenCalled();
  });

  it('purges the deleted message media once the delete has committed', async () => {
    const deleted = { id: 'quest-1', sessionId: 'sess-1', images: ['a.png'], videos: ['b.mp4'] };
    let deletedInTxn = false;
    mockDeleteSessionMessage.mockImplementation(async () => {
      deletedInTxn = txn.active;
      return deleted;
    });
    const { req, res, logger } = fireDelete();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ msg: 'Message deleted' });
    expect(mockPurgeMedia).toHaveBeenCalledTimes(1);
    expect(mockPurgeMedia).toHaveBeenCalledWith(deleted, { logger });
    expect(deletedInTxn).toBe(true);
    expect(purgeCalledInTxn.value).toBe(false);
    expect(mockDeleteSessionMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockPurgeMedia.mock.invocationCallOrder[0]
    );
  });

  it("purges media on the SPA's message delete too, which is served by this handler", async () => {
    const deleted = { id: 'quest-1', sessionId: 'sess-1', images: ['a.png'], videos: [] };
    mockDeleteSessionMessage.mockResolvedValue(deleted);
    const { req, res, logger } = fireDelete();

    await spaHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockPurgeMedia).toHaveBeenCalledWith(deleted, { logger });
  });

  it('does not purge media when the take-down fails before the delete', async () => {
    mockUnpublish.mockRejectedValueOnce(new Error('db down'));
    const { req, res } = fireDelete();

    await expect(handler(req, res)).rejects.toThrow('db down');
    expect(mockPurgeMedia).not.toHaveBeenCalled();
  });

  it('logs a failed post-commit sweep and still reports the committed delete', async () => {
    const failure = new Error('db down');
    mockUnpublish.mockResolvedValueOnce({ artifacts: [], annotations: 0, reports: 0, viewAudits: 0 });
    mockUnpublish.mockRejectedValueOnce(failure);
    const { req, res, logger } = fireDelete();

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ msg: 'Message deleted' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[PUBLISH]'),
      expect.objectContaining({ error: failure, sessionId: 'sess-1', messageId: 'quest-1' })
    );
  });
});
