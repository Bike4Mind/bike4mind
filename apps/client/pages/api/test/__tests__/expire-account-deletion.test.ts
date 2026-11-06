import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isE2EEnabled: vi.fn(() => true),
  findOne: vi.fn(),
  collation: vi.fn(),
  updateOne: vi.fn(),
  completeAccountDeletion: vi.fn(),
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
  User: {
    findOne: (...a: unknown[]) => {
      h.findOne(...a);
      return { collation: (c: unknown) => ({ lean: () => h.collation(c) }) };
    },
    updateOne: h.updateOne,
  },
}));
vi.mock('@server/users/completeAccountDeletion', () => ({ completeAccountDeletion: h.completeAccountDeletion }));

import handler from '../expire-account-deletion';

const USER_ID = '665f1c2e8b3a4d0000000001';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const makeReq = (body: Record<string, unknown> = { email: 'qa-12345678-e2e@test.com' }, secret = 'right-secret') => ({
  method: 'POST',
  query: {},
  body,
  headers: { 'x-e2e-cleanup-secret': secret },
  logger,
});

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};

const call = async (req = makeReq()) => {
  const out = makeRes();
  await handler(req as never, out.res);
  return out;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.sstSecret = { value: 'right-secret' };
  delete process.env.E2E_CLEANUP_SECRET;
  h.isE2EEnabled.mockReturnValue(true);
  h.collation.mockResolvedValue({
    _id: USER_ID,
    deletion: { requestedAt: new Date(), scheduledFor: new Date(), source: 'self' },
  });
  h.updateOne.mockResolvedValue({ modifiedCount: 1 });
  h.completeAccountDeletion.mockResolvedValue({ deleted: true });
});

describe('POST /api/test/expire-account-deletion', () => {
  it('refuses outside development and preview', async () => {
    h.isE2EEnabled.mockReturnValue(false);
    const { status } = await call();

    expect(status).toHaveBeenCalledWith(403);
    expect(h.completeAccountDeletion).not.toHaveBeenCalled();
  });

  it('refuses a wrong cleanup secret', async () => {
    const { status } = await call(makeReq(undefined, 'wrong-secret'));

    expect(status).toHaveBeenCalledWith(401);
    expect(h.completeAccountDeletion).not.toHaveBeenCalled();
  });

  it.each([{ email: 'someone@example.com' }, {}, { email: 42 }])('refuses a non-test email (%j)', async body => {
    const { status } = await call(makeReq(body));

    expect(status).toHaveBeenCalledWith(400);
    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.completeAccountDeletion).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown user', async () => {
    h.collation.mockResolvedValue(null);
    const { status } = await call();

    expect(status).toHaveBeenCalledWith(404);
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('answers 409 when no deletion is pending', async () => {
    h.collation.mockResolvedValue({ _id: USER_ID });
    const { status } = await call();

    expect(status).toHaveBeenCalledWith(409);
    expect(h.updateOne).not.toHaveBeenCalled();
    expect(h.completeAccountDeletion).not.toHaveBeenCalled();
  });

  it('ends the grace period now and runs the purge for that user only', async () => {
    const { status, json } = await call();

    expect(h.findOne).toHaveBeenCalledWith({ email: 'qa-12345678-e2e@test.com' }, '_id deletion');
    const [filter, update] = h.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: USER_ID, deletion: { $ne: null } });
    const now: Date = update.$set['deletion.scheduledFor'];
    expect(h.completeAccountDeletion).toHaveBeenCalledExactlyOnceWith(USER_ID, { logger, now });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ deleted: true });
  });

  it('returns the skip reason when the purge skipped the account', async () => {
    h.completeAccountDeletion.mockResolvedValue({ deleted: false, reason: 'not_due' });
    const { json } = await call();

    expect(json).toHaveBeenCalledWith({ deleted: false, reason: 'not_due' });
  });
});
