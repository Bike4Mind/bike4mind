import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: unknown, res: unknown) => handlers['POST']?.(req, res), {
      use: () => chain,
      post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
    });
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
// parseAdminActionReason stays real so the route's required-reason check runs here too.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn(async () => null),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

const mockAudit = vi.mocked((await import('@server/utils/adminAudit')).recordAdminActionFromRequest);

// The database, the credit service and withTransaction are REAL here: the whole point is the
// behaviour of a duplicate refund against a replica set. Only the HTTP plumbing and the audit
// writer (a separate concern) are stubbed.
const { CreditTransaction, Organization, creditTransactionRepository } = await import('@bike4mind/database');
const { default: handler } = await import('../top-up');

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await settleAutoIndexBuilds(mongoose);
  // The refund dedupe is decided by the sparse unique index on transactionId.
  await CreditTransaction.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function refundRequest(orgId: string, key: string) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: orgId },
    body: { credits: 250, kind: 'refund', reason: 'duplicate submit', idempotencyKey: key },
  });
  (req as unknown as { user: object }).user = { isAdmin: true, id: 'admin-1', username: 'admin' };
  (req as unknown as { logger: object }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as Handler)(req, res) };
}

describe('POST /api/admin/organizations/[id]/top-up refund concurrency', () => {
  it('settles two concurrent refunds with one key once, answering both quickly', async () => {
    const org = await Organization.create({ name: 'Concurrent Org', userId: 'owner-1', currentCredits: 0 });
    const createTransaction = vi.spyOn(creditTransactionRepository, 'createTransaction');

    const first = refundRequest(String(org._id), 'same-click-uuid');
    const second = refundRequest(String(org._id), 'same-click-uuid');

    const startedAt = Date.now();
    const responses = await Promise.all([first.run(), second.run()]);
    const elapsedMs = Date.now() - startedAt;

    // Both requests must reach the insert: a request answered by the up-front lookup never
    // exercises the in-transaction duplicate path this test exists for. More than two calls is
    // legitimate - the loser's first attempt can lose a write conflict and be retried once.
    expect(createTransaction.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Both answer success - the loser reports the refund as already applied, it does not fail.
    for (const response of responses) expect(response._getStatusCode()).toBe(200);
    const idempotencyFlags = responses.map(r => r._getJSONData().idempotent === true).sort();
    expect(idempotencyFlags).toEqual([false, true]);

    // One credit write, one ledger row, one audit trail entry.
    const transactionId = `admin_refund_${String(org._id)}_same-click-uuid`;
    expect(await CreditTransaction.countDocuments({ transactionId })).toBe(1);
    expect(await CreditTransaction.countDocuments({ ownerId: String(org._id) })).toBe(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect((await Organization.findById(org._id))?.currentCredits).toBe(250);

    // The duplicate is answered, not retried: a retry loop against the aborted transaction runs
    // for minutes and would blow this bound long before it finished.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
