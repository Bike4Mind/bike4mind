import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isE2EEnabled: vi.fn(() => true),
  findOne: vi.fn(),
  lean: vi.fn(),
  updateOne: vi.fn(),
  sstSecret: { value: 'right-secret' } as { value: string } | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: h.isE2EEnabled }));
vi.mock('sst', () => ({
  Resource: {
    get E2E_CLEANUP_SECRET() {
      return h.sstSecret;
    },
  },
}));
vi.mock('@bike4mind/database', () => ({
  AdminApprovalModel: {
    findOne: (...a: unknown[]) => {
      h.findOne(...a);
      return { lean: () => ({ exec: () => h.lean() }) };
    },
    updateOne: h.updateOne,
  },
}));

import handler from '../admin-approval';

const APPROVAL_ID = '665f1c2e8b3a4d0000000001';

const makeReq = (
  body: Record<string, unknown> = { approvalId: APPROVAL_ID, op: 'tamper' },
  secret = 'right-secret'
) => ({
  method: 'POST',
  query: {},
  body,
  headers: { 'x-e2e-cleanup-secret': secret },
});

const call = async (req = makeReq()) => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  await handler(req as never, { json, status } as never);
  return { status, json };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.sstSecret = { value: 'right-secret' };
  delete process.env.E2E_CLEANUP_SECRET;
  h.isE2EEnabled.mockReturnValue(true);
  h.lean.mockResolvedValue({ paramsJson: '{"a":1}', requestedBy: { email: 'setup-admin-1-e2e@test.com' } });
  h.updateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('POST /api/test/admin-approval', () => {
  it('refuses outside development and preview', async () => {
    h.isE2EEnabled.mockReturnValue(false);
    const { status } = await call();

    expect(status).toHaveBeenCalledWith(403);
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('refuses a wrong cleanup secret', async () => {
    const { status } = await call(makeReq(undefined, 'wrong-secret'));

    expect(status).toHaveBeenCalledWith(401);
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it.each([{ approvalId: APPROVAL_ID, op: 'approve' }, { approvalId: 'nope', op: 'tamper' }, {}])(
    'refuses a malformed body (%j)',
    async body => {
      const { status } = await call(makeReq(body));

      expect(status).toHaveBeenCalledWith(400);
      expect(h.findOne).not.toHaveBeenCalled();
    }
  );

  it('404s when no pending approval matches', async () => {
    h.lean.mockResolvedValue(null);
    const { status } = await call();

    expect(status).toHaveBeenCalledWith(404);
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('refuses an approval a real admin requested', async () => {
    h.lean.mockResolvedValue({ paramsJson: '{}', requestedBy: { email: 'admin@example.com' } });
    const { status } = await call();

    expect(status).toHaveBeenCalledWith(400);
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('tamper changes the stored params and leaves the hash alone', async () => {
    const { status } = await call();

    expect(status).toHaveBeenCalledWith(200);
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: APPROVAL_ID, status: 'pending' },
      { $set: { paramsJson: '{"a":1} ' } }
    );
  });

  it('expire moves the deadline into the past', async () => {
    const { status } = await call(makeReq({ approvalId: APPROVAL_ID, op: 'expire' }));

    expect(status).toHaveBeenCalledWith(200);
    const [, update] = h.updateOne.mock.calls[0] as [unknown, { $set: { expiresAt: Date } }];
    expect(update.$set.expiresAt.getTime()).toBeLessThan(Date.now());
    expect(Object.keys(update.$set)).toEqual(['expiresAt']);
  });
});
