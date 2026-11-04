import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings, CreditTransaction, User } from '@bike4mind/database';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { buildSignupGrantSizingReport, bucketOf, formatSizingReport } from './signupGrantSizingReport';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const now = new Date('2026-11-04T12:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

beforeEach(async () => {
  await User.collection.deleteMany({});
  await CreditTransaction.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await AdminSettings.collection.insertOne({ settingName: 'signupGrantDripCap', settingValue: '9000' });
});

const oid = () => new mongoose.Types.ObjectId();

const insertUser = async (extra: Record<string, unknown> = {}) => {
  const _id = oid();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    email: `${_id}@sizing.example`,
    emailVerified: true,
    currentCredits: 0,
    ...extra,
  });
  return _id;
};

const insertLedger = (userId: mongoose.Types.ObjectId, transactionId: string, credits: number) =>
  CreditTransaction.collection.insertOne({
    ownerId: String(userId),
    ownerType: 'User',
    type: 'generic_add',
    transactionId,
    credits,
    createdAt: now,
  });

const grant = (extra: Record<string, unknown> = {}) => ({
  stage: 'signup',
  signupCredits: 1000,
  unlockCredits: 9000,
  creditsReleased: 1000,
  nextCondition: 'verification',
  ...extra,
});

async function seed() {
  // Flat-grant cohort: verified with spread balances and ledger receipts, plus one unverified.
  for (const balance of [-3, 0, 1, 1, 50, 500, 2500]) {
    const id = await insertUser({ currentCredits: balance, lastActiveAt: daysAgo(3) });
    await insertLedger(id, `verify-grant:${id}`, balance > 0 ? 1000 : 0);
  }
  await insertUser({ emailVerified: false });
  await insertUser({ isBanned: true, lastActiveAt: daysAgo(1) });
  await insertUser({ isAdmin: true });
  await insertUser({ tags: [PENDING_FREE_CREDITS_TAG] });

  // Staged: one mid-drip account that has dripped 400, one completed by verification, one not yet paid.
  const dripping = await insertUser({ signupGrant: grant({ creditsReleased: 1400, dripCredits: 400 }) });
  await insertLedger(dripping, `verify-grant:${dripping}`, 1000);
  await insertLedger(dripping, `unlock-grant:activity:${dripping}:2026-11-01`, 400);
  const stale = await insertUser({ signupGrant: grant({ creditsReleased: 1000 }) });
  await insertLedger(stale, `verify-grant:${stale}`, 1500);
  await insertUser({ signupGrant: grant({ stage: 'unlocked', creditsReleased: 10000, unlockedBy: 'card_verified' }) });
  await insertUser({
    signupGrant: grant({ stage: 'pending_email', creditsReleased: 0, nextCondition: 'email_verification' }),
  });
}

describe('buildSignupGrantSizingReport', () => {
  it('buckets balances into the report ranges', () => {
    expect([-1, 0, 1, 2, 99, 100, 999, 1000, 5000].map(bucketOf)).toEqual([
      '<0',
      '0',
      '1',
      '2-99',
      '2-99',
      '100-999',
      '100-999',
      '1000+',
      '1000+',
    ]);
  });

  it('counts the cohorts, sums received credits from the ledger and sizes the remaining drip', async () => {
    await seed();
    const report = await buildSignupGrantSizingReport({ now });

    expect(report.users).toEqual({ total: 15, withSignupGrant: 4, withoutSignupGrant: 11 });
    expect(report.flatGrant.verified).toBe(10);
    expect(report.flatGrant.unverified).toBe(1);
    expect(report.flatGrant.verifiedBalance).toEqual({ '<0': 1, '0': 4, '1': 2, '2-99': 1, '100-999': 1, '1000+': 1 });
    expect(report.flatGrant.verifiedReceived).toEqual({ '<0': 0, '0': 5, '1': 0, '2-99': 0, '100-999': 0, '1000+': 5 });
    expect(report.banned).toBe(1);
    expect(report.admins).toBe(1);
    expect(report.activeLast30Days).toBe(7);
    expect(report.pendingFreeCreditsTagged).toBe(1);

    expect(report.staged.byStage).toEqual({ pending_email: 1, signup: 2, unlocked: 1 });
    expect(report.staged.inFlight).toBe(2);
    expect(report.staged.inFlightReceived).toBe(1400 + 1500);
    // creditsReleased was 1000 where the ledger shows 1500 for one account; the dripping account matches.
    expect(report.staged.inFlightLedgerMismatch).toBe(1);
    expect(report.dripCap).toBe(9000);
    expect(report.staged.remainingToDrip).toBe(9000 - 400 + 9000);
  });

  it('writes nothing and returns only aggregate numbers', async () => {
    await seed();
    const usersBefore = await User.collection.find({}).sort({ _id: 1 }).toArray();
    const ledgerBefore = await CreditTransaction.collection.countDocuments({});
    const settingsBefore = await AdminSettings.collection.find({}).toArray();

    const report = await buildSignupGrantSizingReport({ now });

    expect(await User.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(usersBefore);
    expect(await CreditTransaction.collection.countDocuments({})).toBe(ledgerBefore);
    expect(await AdminSettings.collection.find({}).toArray()).toEqual(settingsBefore);

    const output = JSON.stringify(report) + formatSizingReport(report).join('\n');
    for (const user of usersBefore) {
      expect(output).not.toContain(String(user._id));
      expect(output).not.toContain(String(user.email));
    }
    expect(output).not.toMatch(/mongodb(\+srv)?:\/\//);
    expect(Object.keys(report).sort()).toEqual(
      [
        'activeLast30Days',
        'admins',
        'banned',
        'dripCap',
        'dripCapSource',
        'flatGrant',
        'generatedAt',
        'pendingFreeCreditsTagged',
        'staged',
        'users',
      ].sort()
    );
  });
});
