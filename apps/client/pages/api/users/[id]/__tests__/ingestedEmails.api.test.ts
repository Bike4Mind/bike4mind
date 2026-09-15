import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';

const { mockDeleteMany, mockFind, mockCountDocuments } = vi.hoisted(() => ({
  mockDeleteMany: vi.fn(),
  mockFind: vi.fn(),
  mockCountDocuments: vi.fn(),
}));

// baseApi mock: creates a callable chain that routes by req.method
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => {
          h.GET = fns[fns.length - 1];
          return chain;
        },
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => {
          h.DELETE = fns[fns.length - 1];
          return chain;
        },
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  IngestedEmailModel: {
    find: (...args: unknown[]) => mockFind(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
    deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
  },
}));

// Import handler after mocks are registered
import handler from '@pages/api/users/[id]/ingested-emails';

const invoke = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

function deleteReq(userId: string, emailIds: unknown, user = { id: userId, isAdmin: false }) {
  const { req, res } = createMocks({
    method: 'DELETE',
    query: { id: userId },
    body: { emailIds },
  });
  (req as unknown as Record<string, unknown>).user = user;
  return { req, res };
}

describe('DELETE /api/users/[id]/ingested-emails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMany.mockResolvedValue({ deletedCount: 2 });
  });

  it('returns 403 when deleting another user’s emails without admin', async () => {
    const { req, res } = deleteReq('user-2', [new mongoose.Types.ObjectId().toHexString()], {
      id: 'user-1',
      isAdmin: false,
    });
    await invoke(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('returns 400 when emailIds is missing or empty', async () => {
    const { req, res } = deleteReq('user-1', []);
    await invoke(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('returns 400 (not 500) when an emailId is not a valid ObjectId', async () => {
    const valid = new mongoose.Types.ObjectId().toHexString();
    const { req, res } = deleteReq('user-1', [valid, 'not-an-object-id']);
    await invoke(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid emailIds', invalid: ['not-an-object-id'] });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it('passes validated string IDs directly to deleteMany (casting is handled inside the soft-delete plugin)', async () => {
    const id1 = new mongoose.Types.ObjectId();
    const id2 = new mongoose.Types.ObjectId();
    const { req, res } = deleteReq('user-1', [id1.toHexString(), id2.toHexString()]);
    await invoke(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ deletedCount: 2 });

    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    const filter = mockDeleteMany.mock.calls[0][0] as {
      _id: { $in: unknown[] };
      userId: string;
    };
    expect(filter.userId).toBe('user-1');
    expect(filter._id.$in).toHaveLength(2);
    // Call site now passes strings - castIdFilter inside softDeletePlugin converts them
    // to ObjectId before the raw driver is called. The mock captures the pre-cast call.
    expect(filter._id.$in).toEqual([id1.toHexString(), id2.toHexString()]);
  });
});
