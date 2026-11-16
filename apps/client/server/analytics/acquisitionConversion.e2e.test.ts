import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { GatewayTimeoutError } from '@bike4mind/common';
import { AnalyticsUserDay, CreditTransaction, User } from '@bike4mind/database';
import { acquisitionCohortUserIds } from '@bike4mind/server-utils/analytics/acquisitionConversion';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { classifyFunnelCohort } from '@bike4mind/server-utils/analytics/activationFunnel';
import { acquisitionQuerySchema, ACQUISITION_UNATTRIBUTED_LABEL } from '@client/app/utils/acquisitionConversion';
import { getAcquisitionConversion } from './acquisitionConversionSummary';
import { toUserAcquisition } from './funnel';
import { adminUsersPipeline } from '@bike4mind/server-utils/admin/usersList/listAdminUsers';
import { AdminUsersFilterSchema } from '@bike4mind/server-utils/app/utils/adminUsersFilter';
import { ACQUISITION_NONE } from '@client/app/utils/acquisitionConversion';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const NOW = new Date('2026-06-15T12:00:00Z');
const signup = new Date('2026-06-10T10:00:00Z');
const query = (touch: 'first' | 'last') =>
  acquisitionQuerySchema.parse({ range: 'custom', from: '2026-06-01', to: '2026-06-15', signups: 'all', touch });

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Touch = { source: string; medium?: string; campaign?: string };
let seq = 0;

/** A signup whose acquisition is written by the same helper the signup path uses. */
const seedSignup = async (
  touches: { firstTouch?: Touch; lastTouch?: Touch },
  fields: Record<string, unknown> = {},
  verifiedTouch?: Parameters<typeof toUserAcquisition>[3]
) => {
  const name = `u${seq++}`;
  const acquisition = toUserAcquisition(touches, 'email', signup, verifiedTouch);
  return User.create({
    name,
    username: name,
    email: `${name}@${name}.customer.example.org`,
    emailVerified: true,
    createdAt: signup,
    ...(acquisition && { acquisition }),
    ...fields,
  });
};

const rowsOf = async (touch: 'first' | 'last') => {
  const result = await getAcquisitionConversion(query(touch), NOW);
  if (result.status !== 'ok') throw new Error(`unexpected status ${result.status}`);
  return result;
};

describe('getAcquisitionConversion', () => {
  it('groups by source/medium/campaign, case-folded, with an unattributed bucket and coverage', async () => {
    await User.createIndexes();
    await seedSignup({ firstTouch: { source: 'Google', medium: 'CPC', campaign: 'Spring' } });
    await seedSignup({ firstTouch: { source: ' google ', medium: 'cpc', campaign: 'spring' } });
    await seedSignup({ firstTouch: { source: 'newsletter' } });
    await seedSignup({});
    await seedSignup({ firstTouch: { source: '   ' } });
    await seedSignup({}, {}, { srcProductId: 'other-product', hopId: 'hop1', redeemedAt: signup });

    const result = await rowsOf('first');

    expect(result.rows).toEqual([
      expect.objectContaining({ kind: 'touch', key: 'google|cpc|spring', source: 'google', signups: 2 }),
      expect.objectContaining({ kind: 'touch', key: 'newsletter|(none)|(none)', medium: '(none)', signups: 1 }),
      expect.objectContaining({ kind: 'unattributed', key: 'unattributed', source: null, signups: 3 }),
    ]);
    expect(result.coverage).toEqual({ signups: 6, attributed: 3, pct: 50 });
    expect(result.truncated).toBe(false);
    expect(ACQUISITION_UNATTRIBUTED_LABEL).toMatch(/consent unknown/i);
  });

  it('leaves out internal, synthetic, admin and banned accounts', async () => {
    await User.createIndexes();
    const touch = { firstTouch: { source: 'ads' } };
    await seedSignup(touch);
    await seedSignup(touch, { isInternal: true });
    await seedSignup(touch, { isSynthetic: true });
    await seedSignup(touch, { isAdmin: true });
    await seedSignup(touch, { isBanned: true });

    const result = await rowsOf('first');

    expect(result.coverage).toEqual({ signups: 1, attributed: 1, pct: 100 });
    expect(result.rows).toEqual([expect.objectContaining({ key: 'ads|(none)|(none)', signups: 1 })]);
  });

  it('splits first and last touch, each falling back to the other when missing', async () => {
    await User.createIndexes();
    await seedSignup({ firstTouch: { source: 'blog' }, lastTouch: { source: 'ads', medium: 'cpc' } });
    await seedSignup({ firstTouch: { source: 'blog' } });
    await seedSignup({ lastTouch: { source: 'ads', medium: 'cpc' } });

    const first = await rowsOf('first');
    const last = await rowsOf('last');

    expect(first.rows.map(row => [row.key, row.signups])).toEqual([
      ['blog|(none)|(none)', 2],
      ['ads|cpc|(none)', 1],
    ]);
    expect(last.rows.map(row => [row.key, row.signups])).toEqual([
      ['ads|cpc|(none)', 2],
      ['blog|(none)|(none)', 1],
    ]);
    expect(first.coverage).toEqual(last.coverage);
  });

  it('keeps the top 50 touch rows and sums the rest into one other row', async () => {
    await User.createIndexes();
    await seedSignup({ firstTouch: { source: 'big' } });
    await seedSignup({ firstTouch: { source: 'big' } });
    for (let i = 0; i <= 50; i++) await seedSignup({ firstTouch: { source: `s${String(i).padStart(2, '0')}` } });

    const result = await rowsOf('first');

    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(51);
    expect(result.rows[0]).toMatchObject({ key: 'big|(none)|(none)', signups: 2 });
    expect(result.rows[49]).toMatchObject({ key: 's48|(none)|(none)' });
    expect(result.rows[50]).toMatchObject({ kind: 'other', key: 'other', signups: 2 });
    expect(result.coverage.signups).toBe(53);
  });

  it('reports an empty window with no rows and a null coverage rate', async () => {
    const result = await rowsOf('first');
    expect(result.rows).toEqual([]);
    expect(result.coverage).toEqual({ signups: 0, attributed: 0, pct: null });
  });

  it('refuses a range longer than the Users drill-down accepts', async () => {
    const result = await getAcquisitionConversion(acquisitionQuerySchema.parse({ range: '12m' }), NOW);
    expect(result).toEqual({ status: 'rangeTooLong', maxDays: 93 });
  });

  it('reports conversion, provisional cohorts, retention and derived renewals per row', async () => {
    await User.createIndexes();
    const april = { createdAt: new Date('2026-04-01T08:00:00Z') };
    const ads = { firstTouch: { source: 'ads' } };
    const refunded = await seedSignup(ads, april);
    const renewing = await seedSignup(ads, april);
    const noInterval = await seedSignup(ads, april);
    const fresh = await seedSignup(
      { firstTouch: { source: 'fresh' } },
      { createdAt: new Date('2026-06-10T08:00:00Z') }
    );
    await seedSignup({}, april);

    const paidAt = new Date('2026-04-02T12:00:00Z');
    const purchase = (ownerId: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
      CreditTransaction.collection.insertOne({
        ownerId,
        ownerType: 'User',
        credits: 500,
        type: 'purchase',
        status: 'completed',
        stripePaymentIntentId: `pi_${ownerId}`,
        createdAt,
        updatedAt: createdAt,
        ...extra,
      });
    const subscription = (ownerId: string, fields: Record<string, unknown>) =>
      Subscription.collection.insertOne({
        ownerType: 'User',
        ownerId,
        subscriptionId: `sub_${ownerId}`,
        priceId: 'price_1',
        status: 'active',
        source: 'stripe',
        quantity: 1,
        createdAt: paidAt,
        ...fields,
      });
    await purchase(String(refunded._id), paidAt, { reversedAt: new Date('2026-04-10T00:00:00Z') });
    await subscription(String(renewing._id), {
      interval: 'month',
      intervalCount: 1,
      periodStartsAt: new Date('2026-06-02T12:00:00Z'),
    });
    await subscription(String(noInterval._id), { periodStartsAt: paidAt });
    await purchase(String(fresh._id), new Date('2026-06-11T12:00:00Z'));

    const result = await getAcquisitionConversion(
      acquisitionQuerySchema.parse({
        range: 'custom',
        from: '2026-04-01',
        to: '2026-06-15',
        signups: 'all',
        followUp: '60',
      }),
      NOW
    );
    if (result.status !== 'ok') throw new Error(`unexpected status ${result.status}`);

    expect(result).toMatchObject({ conversionWindowDays: 30, followUpDays: 60, renewalBasis: 'subscription-state' });
    const byKey = Object.fromEntries(result.rows.map(row => [row.key, row]));
    expect(byKey['ads|(none)|(none)']).toMatchObject({
      signups: 3,
      matureSignups: 3,
      converted: 3,
      creditFirst: 1,
      subscriptionFirst: 2,
      conversionPct: 100,
      provisional: false,
      retained: 2,
      followUpBuyers: 3,
      followUpPending: 0,
      repeatCredit: 0,
      renewalDue: 1,
      renewed: 1,
      renewalUnavailable: 1,
    });
    expect(byKey['fresh|(none)|(none)']).toMatchObject({
      signups: 1,
      matureSignups: 0,
      converted: 0,
      provisionalConverted: 1,
      conversionPct: null,
      provisional: true,
    });
    expect(byKey.unattributed).toMatchObject({ signups: 1, matureSignups: 1, converted: 0, conversionPct: 0 });
    expect(result.totals).toMatchObject({ signups: 5, matureSignups: 4, converted: 3, provisionalConverted: 1 });
  });

  it('drills every row down to a Users list of the same size, signups and converted', async () => {
    await User.createIndexes();
    const april = { createdAt: new Date('2026-04-01T08:00:00Z') };
    const paid = await seedSignup({ firstTouch: { source: 'Ads', medium: 'CPC', campaign: 'Spring' } }, april);
    await seedSignup({ firstTouch: { source: ' ads ', medium: 'cpc', campaign: 'spring' } }, april);
    await seedSignup({ firstTouch: { source: 'news' }, lastTouch: { source: 'ads', medium: 'cpc' } }, april);
    const unattributedBuyer = await seedSignup({}, april);
    await seedSignup({}, { createdAt: new Date('2026-06-10T08:00:00Z') });
    await seedSignup(
      { firstTouch: { source: 'ads', medium: 'cpc', campaign: 'spring' } },
      {
        ...april,
        isInternal: true,
      }
    );
    for (const owner of [paid, unattributedBuyer]) {
      await CreditTransaction.collection.insertOne({
        ownerId: String(owner._id),
        ownerType: 'User',
        credits: 500,
        type: 'purchase',
        status: 'completed',
        stripePaymentIntentId: `pi_${owner._id}`,
        createdAt: new Date('2026-04-03T00:00:00Z'),
      });
    }

    for (const touch of ['first', 'last'] as const) {
      const result = await getAcquisitionConversion(
        acquisitionQuerySchema.parse({ range: 'custom', from: '2026-04-01', to: '2026-06-15', signups: 'all', touch }),
        NOW
      );
      if (result.status !== 'ok') throw new Error(`unexpected status ${result.status}`);
      expect(result.rows.length).toBeGreaterThan(1);
      for (const row of result.rows) {
        for (const converted of [false, true]) {
          // Built the way the Analytics page builds its drill-down link.
          const filter = AdminUsersFilterSchema.parse({
            ...result.window,
            acqTouch: touch,
            ...(row.kind === 'unattributed'
              ? { acqUnattributed: 'true' }
              : {
                  acqSource: row.source,
                  acqMedium: row.medium === ACQUISITION_NONE ? undefined : row.medium,
                  acqCampaign: row.campaign === ACQUISITION_NONE ? undefined : row.campaign,
                }),
            ...(converted ? { acqConverted: 'true', acqWindow: String(result.conversionWindowDays) } : {}),
          });
          const [counted] = await User.aggregate([...(await adminUsersPipeline(filter, NOW)), { $count: 'n' }]);
          expect(counted?.n ?? 0, `${touch} ${row.key} converted=${converted}`).toBe(
            converted ? row.converted : row.signups
          );
        }
      }
    }
  });

  it('fails a drill-down that outlives its budget with a 504', async () => {
    await seedSignup({ firstTouch: { source: 'ads' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ids = acquisitionCohortUserIds(
        { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-15T00:00:00Z') },
        { touch: 'first', key: 'ads|(none)|(none)', converted: true, windowDays: 30 },
        { now: NOW, expiresAt: Date.now() + 5_000 }
      );
      vi.advanceTimersByTime(5_000);
      await expect(ids).rejects.toBeInstanceOf(GatewayTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts first action and came back per row by the funnel rules, judging only week-old signups', async () => {
    await Promise.all([User.createIndexes(), AnalyticsUserDay.createIndexes()]);
    const weekOld = { createdAt: new Date('2026-06-02T10:00:00Z') };
    const ads = { firstTouch: { source: 'ads' } };
    const [returning, oneDay, , lateOnly, fresh] = await Promise.all([
      seedSignup(ads, weekOld),
      seedSignup(ads, weekOld),
      seedSignup(ads, weekOld),
      seedSignup(ads, weekOld),
      seedSignup(ads),
    ]);
    const activeOn = (user: { _id: unknown }, days: string[]) =>
      Promise.all(
        days.map(day =>
          AnalyticsUserDay.collection.insertOne({ day, userId: String(user._id), ownerType: 'User', suspected: false })
        )
      );
    await Promise.all([
      activeOn(returning, ['2026-06-02', '2026-06-05']),
      activeOn(oneDay, ['2026-06-02']),
      activeOn(lateOnly, ['2026-06-12']),
      activeOn(fresh, ['2026-06-10', '2026-06-11']),
    ]);

    const result = await rowsOf('first');

    expect(result.rows.find(row => row.key === 'ads|(none)|(none)')).toMatchObject({
      signups: 5,
      activationSignups: 4,
      firstAction: 2,
      cameBack: 1,
    });
  });

  it('leaves the activation funnel cohort unchanged by the shared eligibility read', async () => {
    await User.createIndexes();
    const counted = await seedSignup(
      { firstTouch: { source: 'ads' } },
      { createdAt: new Date('2026-06-01T00:00:00Z') }
    );
    await seedSignup({}, { createdAt: new Date('2026-06-01T00:00:00Z'), isAdmin: true });

    const { members } = await classifyFunnelCohort(
      { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-02T00:00:00Z') },
      { now: NOW, deadlineMs: 10_000, needsPayments: false }
    );

    expect(members.map(member => member.id)).toEqual([String(counted._id)]);
  });
});
