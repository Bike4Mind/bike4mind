import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { mongoose, RegistrationInvite } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../../../packages/database/src/__test__/createMongoServer';

const audit = vi.hoisted(() => vi.fn());

// Real adminApi permission gate; only the transport (baseApi) is stubbed so the middleware runs in-line.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    let post: ((req: unknown, res: unknown) => unknown) | undefined;
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return post?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((post = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
// parseAdminActionReason stays real so the 400 is the production one.
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: audit,
}));

import handler from '../update';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await RegistrationInvite.createCollection();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  audit.mockResolvedValue(null);
  await RegistrationInvite.deleteMany({});
});

const post = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { body, user: { id: 'admin-1', isAdmin: true }, ability: {} });
  const call = handler as unknown as (req: unknown, res: unknown) => Promise<unknown>;
  const error = await call(req, res).then(
    () => null,
    (thrown: unknown) => thrown
  );
  return { res, error };
};

const seed = (code: string, fields: Record<string, unknown>) =>
  RegistrationInvite.create({ userId: 'admin-1', code, ...fields }).then(invite => String(invite._id));

describe('POST /api/reg-invites/update - reopening package-linked codes (real Mongo)', () => {
  it('refuses reopening an admin-closed package code without a reason and leaves it closed', async () => {
    const id = await seed('CLOSED1', { status: 'used', used: new Date(), grantPackageId: 'pkg-1' });

    const { error } = await post({ ids: [id], status: 'open' });

    expect(error).toHaveProperty('statusCode', 400);
    const stored = await RegistrationInvite.findById(id).lean();
    expect(stored?.status).toBe('used');
    expect(stored?.used).toBeInstanceOf(Date);
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses re-arming a redeemed single-use package code in a mixed batch without a reason', async () => {
    const plain = await seed('PLAIN1', { status: 'used', used: new Date() });
    const redeemed = await seed('REDEEMED1', { status: 'waiting', used: new Date(), grantPackageId: 'pkg-1' });

    const { error } = await post({ ids: [plain, redeemed], status: 'waiting' });

    expect(error).toHaveProperty('statusCode', 400);
    expect((await RegistrationInvite.findById(plain).lean())?.status).toBe('used');
  });

  it('reopens with a reason, clears the redemption, and audits the reason', async () => {
    const id = await seed('CLOSED2', { status: 'used', used: new Date(), grantPackageId: 'pkg-1' });

    const { res, error } = await post({ ids: [id], status: 'open', reason: 'Partner asked to restore the code' });

    expect(error).toBeNull();
    expect(res._getStatusCode()).toBe(200);
    const stored = await RegistrationInvite.findById(id).lean();
    expect(stored?.status).toBe('open');
    expect(stored?.used).toBeUndefined();
    expect(audit.mock.calls[0][1]).toMatchObject({ reason: 'Partner asked to restore the code' });
  });

  it('needs no reason to reopen a code with no package or a used unlimited-use package code', async () => {
    const plain = await seed('PLAIN2', { status: 'used', used: new Date() });
    const unlimited = await seed('UNLIMITED1', {
      status: 'open',
      used: new Date(),
      unlimitedUse: true,
      grantPackageId: 'pkg-1',
    });

    const { error } = await post({ ids: [plain, unlimited], status: 'open' });

    expect(error).toBeNull();
    expect((await RegistrationInvite.findById(plain).lean())?.status).toBe('open');
    expect(audit.mock.calls[0][1].reason).toBeUndefined();
  });

  it('closes package codes without a reason', async () => {
    const id = await seed('OPEN1', { status: 'open', grantPackageId: 'pkg-1' });

    expect((await post({ ids: [id], status: 'used' })).error).toBeNull();
    expect((await RegistrationInvite.findById(id).lean())?.status).toBe('used');
  });
});
