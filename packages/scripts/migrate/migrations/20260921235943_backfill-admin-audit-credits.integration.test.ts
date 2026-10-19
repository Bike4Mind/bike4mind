import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { AdminAuditLogModel, CreditTransaction } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration, { resolveSignedCredits } from './20260921235943_backfill-admin-audit-credits';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

// Raw driver: the model refuses nothing on insert, but these stand in for rows written before the stamp.
const seedEntry = async (entry: Record<string, unknown>) => {
  const _id = new Types.ObjectId();
  await AdminAuditLogModel.collection.insertOne({ _id, category: 'credits', occurredAt: new Date(), ...entry });
  return _id;
};

const creditsOf = async (id: Types.ObjectId) =>
  ((await AdminAuditLogModel.collection.findOne({ _id: id })) as { details?: { credits?: unknown } } | null)?.details
    ?.credits;

describe('20260921235943 backfill-admin-audit-credits', () => {
  it('stamps a signed amount on every credit-moving action from the best source on the entry', async () => {
    const ledgerId = new Types.ObjectId();
    await CreditTransaction.collection.insertOne({ _id: ledgerId, type: 'generic_deduct', credits: -75 });

    const fromLedger = await seedEntry({
      action: 'user.credits.adjusted',
      summary: 'deducted 75 credits',
      related: { creditTransactionId: ledgerId.toString() },
    });
    const fromChanges = await seedEntry({
      action: 'user.credits.adjusted',
      changes: [{ field: 'currentCredits', before: 100, after: 350 }],
    });
    const fromSummary = await seedEntry({ action: 'user.credits.adjusted', summary: 'deducted 40 credits' });
    const orgGrant = await seedEntry({ action: 'org.credits.granted', details: { seats: 5, initialCredits: 9000 } });

    await migration.up();

    expect(await creditsOf(fromLedger)).toBe(-75);
    expect(await creditsOf(fromChanges)).toBe(250);
    expect(await creditsOf(fromSummary)).toBe(-40);
    expect(await creditsOf(orgGrant)).toBe(9000);
  });

  it('never overwrites an existing stamp, leaves unrecoverable rows alone, and is re-runnable', async () => {
    const stamped = await seedEntry({ action: 'org.credits.topped_up', details: { credits: 1200 } });
    const unknown = await seedEntry({ action: 'user.subscription.granted', details: { subscriptionType: 'team' } });
    const unrelated = await seedEntry({
      action: 'user.email.verified',
      category: 'identity',
      summary: 'granted 9 credits',
    });

    await migration.up();
    await migration.up();

    expect(await creditsOf(stamped)).toBe(1200);
    expect(await creditsOf(unknown)).toBeUndefined();
    expect(await creditsOf(unrelated)).toBeUndefined();
  });
});

describe('resolveSignedCredits', () => {
  const row = (action: string, extra: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    action,
    ...extra,
  });

  it('prefers the ledger amount over the change row and the summary', () => {
    expect(
      resolveSignedCredits(
        row('user.credits.adjusted', {
          summary: 'granted 10 credits',
          changes: [{ field: 'currentCredits', before: 0, after: 20 }],
        }),
        30
      )
    ).toBe(30);
  });

  it('ignores a non-numeric amount', () => {
    expect(resolveSignedCredits(row('org.credits.topped_up', { details: { credits: '100' } }))).toBeUndefined();
  });
});
