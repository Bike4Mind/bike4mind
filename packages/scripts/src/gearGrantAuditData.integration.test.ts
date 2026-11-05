import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  AdminSettings,
  CreditTransaction,
  GearOverride,
  HeldCreditRewardModel,
  PublishedArtifact,
  User,
} from '@bike4mind/database';
import { GEAR_KEYS, GEAR_TRUST_MIN_AGE_DAYS } from '@client/lib/gears/keys';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { DEFAULT_TEST_PATTERN } from './externalActiveUsers';
import { resolveMinAccountAgeDays, runGearGrantAudit } from './gearGrantAuditData';

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

beforeEach(async () => {
  for (const model of [
    AdminSettings,
    CreditTransaction,
    GearOverride,
    HeldCreditRewardModel,
    PublishedArtifact,
    User,
  ]) {
    await model.collection.deleteMany({});
  }
});

const NOW = new Date('2026-11-01T00:00:00Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const testPattern = new RegExp(DEFAULT_TEST_PATTERN, 'i');

// Raw inserts skip schema defaults and timestamps, so createdAt is seeded.
const insertUser = async (email: string, extra: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    email,
    createdAt: daysBefore(40),
    emailVerified: true,
    ...extra,
  });
  return String(_id);
};

const payout = (userId: string, key: string, credits: number, createdAt: Date) =>
  CreditTransaction.collection.insertOne({
    ownerId: userId,
    ownerType: 'User',
    type: 'generic_add',
    credits,
    transactionId: `gear-unlock:${userId}:${key}`,
    metadata: { rewardSource: 'gear' },
    createdAt,
  });

const spend = (userId: string, credits: number, createdAt: Date, extra: Record<string, unknown> = {}) =>
  CreditTransaction.collection.insertOne({
    ownerId: userId,
    ownerType: 'User',
    type: 'text_generation_usage',
    credits: -credits,
    createdAt,
    ...extra,
  });

const hold = (userId: string, key: string, status: string, heldAt: Date) =>
  HeldCreditRewardModel.collection.insertOne({
    transactionId: `gear-unlock:${userId}:${key}`,
    userId,
    credits: 100,
    source: 'gear',
    reason: `gear unlock: ${key}`,
    description: 'Gear unlock reward',
    status,
    heldAt,
  });

describe('resolveMinAccountAgeDays', () => {
  it('uses a valid setting and falls back to the code default otherwise', () => {
    expect(resolveMinAccountAgeDays(3)).toBe(3);
    expect(resolveMinAccountAgeDays(0)).toBe(0);
    expect(resolveMinAccountAgeDays(-1)).toBe(GEAR_TRUST_MIN_AGE_DAYS);
    expect(resolveMinAccountAgeDays(Number.NaN)).toBe(GEAR_TRUST_MIN_AGE_DAYS);
    expect(resolveMinAccountAgeDays('3')).toBe(GEAR_TRUST_MIN_AGE_DAYS);
  });
});

describe('runGearGrantAudit', () => {
  it('reads payouts, queue rows, usage, settings and overrides into the report', async () => {
    // Only two gears stay active, so "every gear" is reachable in a fixture.
    await GearOverride.collection.insertMany(
      GEAR_KEYS.filter(key => key !== 'projects' && key !== 'published').map(key => ({ key, enabled: false }))
    );
    await AdminSettings.collection.insertMany([
      { settingName: 'gearRewardMinAccountAgeDays', settingValue: 3 },
      { settingName: 'freeTierAllowedModels', settingValue: ['small'] },
    ]);

    const alice = await insertUser('alice@customer.example');
    const signup = daysBefore(2);
    const newbie = await insertUser('new@customer.example', { createdAt: signup, emailVerifiedAt: signup });
    const staff = await insertUser('dev@staff.example.com');

    await payout(alice, 'projects', 1000, daysBefore(10));
    await payout(alice, 'published', 5000, daysBefore(9));
    // Out of the window: not read.
    await payout(alice, 'agents', 1000, daysBefore(45));
    await payout(newbie, 'projects', 1000, minutesAfter(signup, 5));
    // Queued at signup + 10 minutes, paid on release hours later.
    await payout(newbie, 'published', 5000, minutesAfter(signup, 300));
    await hold(newbie, 'published', 'paid', minutesAfter(signup, 10));
    await payout(staff, 'projects', 1000, daysBefore(5));
    // Queued before the window and paid inside it: claimed half a day after signup.
    const veteran = await insertUser('veteran@customer.example', { createdAt: daysBefore(31) });
    await hold(veteran, 'projects', 'paid', daysBefore(30.5));
    await payout(veteran, 'projects', 1000, daysBefore(25));
    await payout('not-an-object-id', 'projects', 1000, daysBefore(5));
    // Not a gear payout.
    await CreditTransaction.collection.insertOne({
      ownerId: alice,
      ownerType: 'User',
      type: 'generic_add',
      credits: 777,
      transactionId: `referral:${alice}`,
      createdAt: daysBefore(3),
    });
    // A queue row from before the window, and one refused inside it.
    await hold(alice, 'agents', 'paused', daysBefore(60));
    await hold(alice, 'files', 'void', daysBefore(4));

    await spend(alice, 400, daysBefore(8), { model: 'big' });
    await spend(alice, 100, daysBefore(7), { model: 'small' });
    await spend(alice, 50, daysBefore(6));
    await spend(alice, 999, daysBefore(6), { type: 'generic_deduct' });
    await spend(alice, 999, daysBefore(40), { model: 'big' });
    await spend(staff, 999, daysBefore(4), { model: 'big' });

    await PublishedArtifact.collection.insertOne({ ownerId: alice, deletedAt: null, externalViewCount: 2 });

    const { report, markdown } = await runGearGrantAudit({
      days: 30,
      withinDays: 8,
      top: 5,
      testPattern,
      staffDomainsEnv: 'staff.example.com',
      now: NOW,
      batchSize: 1,
    });

    expect(report.excludedPayouts).toBe(2);
    expect(report.payouts).toEqual({ count: 5, credits: 13000, accounts: 3 });
    expect(report.perGear).toEqual([
      { key: 'published', payouts: 2, accounts: 2, credits: 10000 },
      { key: 'projects', payouts: 3, accounts: 3, credits: 3000 },
    ]);
    expect(report.fastClaims).toEqual({
      activeGears: 2,
      externalSignups: 1,
      tiers: [{ gears: 2, signups: 1, within: 1 }],
    });
    expect(report.spend).toMatchObject({
      gearCredits: 13000,
      spentAfterFirstPayout: 550,
      gearAttributed: 550,
      gearAttributedFrontier: 400,
      gearAttributedUnknown: 50,
    });
    expect(report.checks).toEqual({
      minAccountAgeDays: 3,
      payoutsChecked: 5,
      claimedBelowMinAge: 3,
      signupUnknown: 0,
      claimedBeforeEmailVerified: 0,
      publishedPayouts: 2,
      publishedWithoutExternalView: 1,
      heldByStatus: { held: 0, paid: 1, void: 1, paused: 0 },
    });
    expect(markdown).toContain('## Gear grant audit');
  });

  it('attributes only usage from each account from its first payout on', async () => {
    const early = await insertUser('early@customer.example');
    const late = await insertUser('late@customer.example');
    await payout(early, 'projects', 1000, daysBefore(20));
    await payout(late, 'projects', 1000, daysBefore(10));
    // Inside the batch's read range but before this account's first payout.
    await spend(late, 300, daysBefore(15), { model: 'big' });
    await spend(late, 200, daysBefore(5), { model: 'big' });

    const { report } = await runGearGrantAudit({ days: 30, withinDays: 8, top: 5, testPattern, now: NOW });
    expect(report.spend).toMatchObject({ spentAfterFirstPayout: 200, gearAttributed: 200 });
  });

  it('runs on an empty database with the default clock, batch size and staff domains', async () => {
    const { report } = await runGearGrantAudit({ days: 30, withinDays: 8, top: 10, testPattern });
    expect(report.payouts.count).toBe(0);
    expect(report.fastClaims.activeGears).toBe(GEAR_KEYS.length);
    expect(report.checks.minAccountAgeDays).toBe(GEAR_TRUST_MIN_AGE_DAYS);
  });
});
