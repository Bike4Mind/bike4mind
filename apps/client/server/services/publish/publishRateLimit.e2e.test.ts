import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { PUBLISH_RATE_LIMITED, PUBLISH_RATE_LIMITS, TooManyRequestsError } from '@bike4mind/common';
import {
  consumePublishAction,
  publishActionsKey,
  type PublishActionReceipt,
  type PublishActor,
} from './publishRateLimit';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Against a real database, so the atomic prune-count-append on the cache row is what is under test:
// a mocked cache cannot show the window rolling, or concurrent requests failing to overshoot.

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  vi.useRealTimers();
  await mongoose.connection.dropDatabase();
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NEW_LIMIT = PUBLISH_RATE_LIMITS.newAccount.maxActions;
const LIMIT = PUBLISH_RATE_LIMITS.maxActions;

const newAccount = (id = 'new-user'): PublishActor => ({
  id,
  isAdmin: false,
  createdAt: new Date(Date.now() - DAY_MS),
});
const establishedAccount = (id = 'old-user'): PublishActor => ({
  id,
  isAdmin: false,
  createdAt: new Date(Date.now() - 30 * DAY_MS),
});

/** Run `n` actions one after another; resolves to how many were admitted. */
async function consumeSequentially(actor: PublishActor, n: number): Promise<number> {
  let admitted = 0;
  for (let i = 0; i < n; i++) {
    await consumePublishAction(actor);
    admitted += 1;
  }
  return admitted;
}

/** Run `n` actions one after another; resolves to their receipts. */
async function receiptsFor(actor: PublishActor, n: number): Promise<PublishActionReceipt[]> {
  const receipts: PublishActionReceipt[] = [];
  for (let i = 0; i < n; i++) receipts.push(await consumePublishAction(actor));
  return receipts;
}

/** How many entries the actor's log holds right now, lapsed or not. */
async function logSize(actor: PublishActor): Promise<number> {
  const doc = await mongoose.connection
    .collection<{ key: string; result?: { holders?: unknown[] } }>('caches')
    .findOne({ key: publishActionsKey(actor.id) });
  return doc?.result?.holders?.length ?? 0;
}

async function refusal(actor: PublishActor): Promise<TooManyRequestsError> {
  const error = await consumePublishAction(actor).catch((e: unknown) => e);
  if (!(error instanceof TooManyRequestsError)) throw new Error('expected the publish allowance to refuse');
  return error;
}

describe('consumePublishAction (real database)', () => {
  it('admits a new account its allowance and refuses the next action until the oldest lapses', async () => {
    const actor = newAccount();
    expect(await consumeSequentially(actor, NEW_LIMIT)).toBe(NEW_LIMIT);

    const error = await refusal(actor);
    expect(error.statusCode).toBe(429);
    expect(error.additionalInfo?.code).toBe(PUBLISH_RATE_LIMITED);
    const retryAfter = error.additionalInfo?.retryAfter as number;
    expect(retryAfter).toBeGreaterThan(DAY_MS / 1000 - 60);
    expect(retryAfter).toBeLessThanOrEqual(DAY_MS / 1000);
  });

  it('rolls the window: actions free up one by one as each turns 24 hours old, not all at once', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const actor = { ...newAccount(), createdAt: new Date(t0 - DAY_MS) };

    expect(await consumeSequentially(actor, NEW_LIMIT / 2)).toBe(NEW_LIMIT / 2);
    vi.setSystemTime(t0 + 12 * HOUR_MS);
    expect(await consumeSequentially(actor, NEW_LIMIT / 2)).toBe(NEW_LIMIT / 2);
    await refusal(actor);

    // Just past 24h from the first batch: only that batch has lapsed. A fixed window opened at t0
    // would have reset the whole allowance here.
    vi.setSystemTime(t0 + DAY_MS + 1000);
    expect(await consumeSequentially(actor, NEW_LIMIT / 2)).toBe(NEW_LIMIT / 2);
    const error = await refusal(actor);
    const retryAfter = error.additionalInfo?.retryAfter as number;
    // The next slot opens when the 12h batch lapses, about 12h from now.
    expect(retryAfter).toBeGreaterThan(12 * 3600 - 60);
    expect(retryAfter).toBeLessThanOrEqual(12 * 3600);
  });

  it('never lets concurrent requests overshoot the allowance', async () => {
    const fresh = newAccount('burst-new');
    const veteran = establishedAccount('burst-old');

    const [freshResults, veteranResults] = await Promise.all([
      Promise.allSettled(Array.from({ length: NEW_LIMIT + 30 }, () => consumePublishAction(fresh))),
      Promise.allSettled(Array.from({ length: LIMIT + 30 }, () => consumePublishAction(veteran))),
    ]);

    const tally = (results: PromiseSettledResult<void>[]) => ({
      admitted: results.filter(r => r.status === 'fulfilled').length,
      refused: results.filter(r => r.status === 'rejected' && r.reason instanceof TooManyRequestsError).length,
    });
    expect(tally(freshResults)).toEqual({ admitted: NEW_LIMIT, refused: 30 });
    expect(tally(veteranResults)).toEqual({ admitted: LIMIT, refused: 30 });
  });

  it('keeps one allowance per user, whichever credential the user arrives with', async () => {
    const browser = newAccount('shared-user');
    // An API-key request resolves req.user to the key owner (admin authority withheld), so it is
    // the same user id drawing on the same allowance.
    const apiKeyOwner = { ...newAccount('shared-user'), isAdmin: false };

    await consumeSequentially(browser, NEW_LIMIT / 2);
    await consumeSequentially(apiKeyOwner, NEW_LIMIT / 2);
    await refusal(browser);
    await refusal(apiKeyOwner);

    // Another user is unaffected.
    expect(await consumeSequentially(newAccount('someone-else'), 1)).toBe(1);
  });

  it('lets an account that turns 7 days old use the larger allowance at once', async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const actor = { id: 'graduate', isAdmin: false, createdAt: new Date(t0 - 7 * DAY_MS + HOUR_MS) };

    await consumeSequentially(actor, NEW_LIMIT);
    await refusal(actor);

    vi.setSystemTime(t0 + HOUR_MS);
    expect(await consumeSequentially(actor, 5)).toBe(5);
  });

  it('never counts or refuses an admin', async () => {
    const admin = { ...newAccount('admin-user'), isAdmin: true };
    expect(await consumeSequentially(admin, NEW_LIMIT + 5)).toBe(NEW_LIMIT + 5);
    expect(await mongoose.connection.collection('caches').countDocuments()).toBe(0);
  });
});

describe('PublishActionReceipt.refund (real database)', () => {
  it('hands back exactly one slot per refunded action, however often it is refunded', async () => {
    const actor = newAccount('refund-once');
    const receipts = await receiptsFor(actor, NEW_LIMIT);
    await refusal(actor);

    await receipts[0].refund();
    await receipts[0].refund();
    await Promise.all([receipts[0].refund(), receipts[0].refund()]);

    expect(await logSize(actor)).toBe(NEW_LIMIT - 1);
    expect(await consumeSequentially(actor, 1)).toBe(1);
    await refusal(actor);
  });

  it('under concurrent refunds and new actions, never admits more than were refunded', async () => {
    const actor = establishedAccount('refund-burst');
    const receipts = await receiptsFor(actor, LIMIT);
    const refunded = receipts.slice(0, 25);

    // Each refunded receipt is refunded twice, interleaved with far more new actions than there is room for.
    const [, attempts] = await Promise.all([
      Promise.all([...refunded, ...refunded].map(receipt => receipt.refund())),
      Promise.allSettled(Array.from({ length: LIMIT }, () => consumePublishAction(actor))),
    ]);

    const admitted = attempts.filter(r => r.status === 'fulfilled').length;
    const refused = attempts.filter(r => r.status === 'rejected' && r.reason instanceof TooManyRequestsError).length;
    // A new action that ran before a refund landed is refused, so up to 25 can be admitted; never more.
    expect(admitted).toBeLessThanOrEqual(refunded.length);
    expect(admitted + refused).toBe(LIMIT);
    expect(await logSize(actor)).toBe(LIMIT - refunded.length + admitted);

    // Once every refund has landed, the log has room for exactly the refunds not yet taken back up.
    expect(await consumeSequentially(actor, refunded.length - admitted)).toBe(refunded.length - admitted);
    await refusal(actor);
    expect(await logSize(actor)).toBe(LIMIT);
  });

  it("a refund cannot remove another action's entry, even after its own entry has lapsed", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const actor = { ...newAccount('refund-lapsed'), createdAt: new Date(t0 - DAY_MS) };
    const [stale] = await receiptsFor(actor, 1);

    vi.setSystemTime(t0 + DAY_MS + 1000);
    await receiptsFor(actor, NEW_LIMIT);
    await refusal(actor);

    await stale.refund();
    await refusal(actor);
  });

  it("keeps one user's refunds out of another user's log", async () => {
    const a = newAccount('refund-a');
    const b = newAccount('refund-b');
    const [aReceipt] = await receiptsFor(a, 1);
    await receiptsFor(b, NEW_LIMIT);

    await aReceipt.refund();

    expect(await logSize(b)).toBe(NEW_LIMIT);
    await refusal(b);
  });
});
