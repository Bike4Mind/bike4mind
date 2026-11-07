import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { CreditHolderType } from '@bike4mind/common';
import { AnalyticsUserDay, CreditTransaction, Organization, User } from '@bike4mind/database';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { USER_FUNNEL_STEP_FILTERS, type UserFunnelStep } from '@client/app/utils/adminUsersFilter';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { listAdminUsers } from '../admin/usersList/listAdminUsers';
import { classifyFunnelCohort, funnelStepUserIds } from './activationFunnel';
import { getActivationFunnel } from './activationFunnelSummary';
import { signupVerdictUserIds } from './realSignup';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const NOW = new Date('2026-06-15T12:00:00Z');
const viewer = { userId: 'a'.repeat(24), isAdmin: true };
const params = { page: 1, limit: 100, sortField: 'createdAt', sortOrder: 'desc' } as const;
const query = { range: 'custom', from: '2026-05-01', to: '2026-06-15', compare: 'off' } as const;
const signup = new Date('2026-05-10T10:00:00Z');

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

const seedUser = (name: string, fields: Record<string, unknown> = {}) =>
  User.create({ name, username: name, email: `${name}@${name}.customer.example.org`, createdAt: signup, ...fields });

const seedActive = (userId: string, days: string[]) =>
  Promise.all(
    days.map(day => AnalyticsUserDay.collection.insertOne({ day, userId, ownerType: 'User', suspected: false }))
  );

const seedPurchase = async (ownerId: string, createdAt: Date) => {
  await CreditTransaction.collection.insertOne({
    ownerId,
    ownerType: CreditHolderType.User,
    credits: 500,
    type: 'purchase',
    status: 'completed',
    createdAt,
    updatedAt: createdAt,
  });
};

const seedSubscription = (ownerType: 'User' | 'Organization', ownerId: string, fields: Record<string, unknown> = {}) =>
  Subscription.collection.insertOne({
    ownerType,
    ownerId,
    subscriptionId: `sub_${ownerId}`,
    priceId: 'price_1',
    status: 'active',
    source: 'stripe',
    quantity: 1,
    periodStartsAt: signup,
    periodEndsAt: new Date('2026-07-10T00:00:00Z'),
    createdAt: new Date('2026-05-20T00:00:00Z'),
    ...fields,
  });

/** Regular journeys (one per step, plus payment edge cases) and a same-hour burst of suspected signups. */
async function seedCohort() {
  await Promise.all([User.createIndexes(), AnalyticsUserDay.createIndexes()]);
  const journey = async (name: string, days: string[], fields: Record<string, unknown> = {}) => {
    const user = await seedUser(name, fields);
    await seedActive(String(user._id), days);
    return String(user._id);
  };
  await journey('neverUsed', ['2026-05-18']);
  await journey('triedOnce', ['2026-05-10']);
  await journey('returned', ['2026-05-10', '2026-05-17']);
  const packBuyer = await journey('packBuyer', ['2026-05-10', '2026-05-11']);
  await seedPurchase(packBuyer, new Date('2026-06-09T23:00:00Z'));
  const latePayer = await journey('latePayer', ['2026-05-10', '2026-05-11']);
  await seedPurchase(latePayer, new Date('2026-06-10T00:00:00Z'));
  const teamOwner = await journey('teamOwner', ['2026-05-11']);
  const team = await Organization.create({ name: 'Team', userId: teamOwner });
  await seedSubscription('Organization', String(team._id));
  const comped = await journey('comped', ['2026-05-12']);
  await seedSubscription('User', comped, { source: 'admin_grant', subscriptionId: 'admin_grant_x' });
  await journey('staffer', ['2026-05-10', '2026-05-11'], { isAdmin: true });
  await seedUser('tooNew', { createdAt: new Date('2026-06-10T00:00:00Z') });
  await seedUser('outside', { createdAt: new Date('2026-04-20T00:00:00Z') });

  const burstDays: string[][] = [[], [], [], ['2026-05-12'], ['2026-05-12'], ['2026-05-12', '2026-05-13']];
  for (let i = 0; i < 12; i++) {
    const days = burstDays[i % burstDays.length];
    const id = String(
      (
        await seedUser(`burst${i}`, {
          email: `burst${i}@burst.example.net`,
          createdAt: new Date(`2026-05-12T09:${String(10 + i).padStart(2, '0')}:00Z`),
          lastActiveAt: new Date('2026-05-14T09:00:00Z'),
        })
      )._id
    );
    await seedActive(id, days);
  }
}

const DAY_MS = 86_400_000;
const dayIndex = (date: Date | string) => Math.floor(new Date(date).getTime() / DAY_MS);

/**
 * The funnel rule re-derived from direct collection reads, independent of the funnel module:
 * first action = activity on days 0..7 after the signup day, came back = days 1..7, paid = a collected
 * payment on days 0..30. Returns each judged user's furthest step.
 */
async function expectedSteps(judged: { _id: unknown; createdAt: Date }[]) {
  const ids = judged.map(user => String(user._id));
  const activity = await AnalyticsUserDay.find({ userId: { $in: ids } }).lean<{ userId: string; day: string }[]>();
  const purchases = await CreditTransaction.find({
    ownerId: { $in: ids },
    type: 'purchase',
    status: 'completed',
  }).lean<{ ownerId: string; createdAt: Date }[]>();
  const organizations = await Organization.find({ userId: { $in: ids } }).lean<{ _id: unknown; userId: string }[]>();
  const ownerOf = new Map(organizations.map(org => [String(org._id), org.userId]));
  const subscriptions = await Subscription.find({
    source: 'stripe',
    status: { $nin: ['incomplete', 'incomplete_expired', 'trialing'] },
  }).lean<{ ownerType: string; ownerId: string; createdAt: Date }[]>();
  const paidDates = new Map<string, Date[]>();
  const addPaid = (userId: string | undefined, at: Date) => {
    if (userId) paidDates.set(userId, [...(paidDates.get(userId) ?? []), at]);
  };
  for (const purchase of purchases) addPaid(purchase.ownerId, purchase.createdAt);
  for (const sub of subscriptions) {
    addPaid(sub.ownerType === 'User' ? sub.ownerId : ownerOf.get(sub.ownerId), sub.createdAt);
  }
  const steps = new Map<string, UserFunnelStep>();
  for (const user of judged) {
    const id = String(user._id);
    const signupDay = dayIndex(user.createdAt);
    const offsets = activity.filter(row => row.userId === id).map(row => dayIndex(row.day) - signupDay);
    const first = offsets.some(offset => offset >= 0 && offset <= 7);
    const back = offsets.some(offset => offset >= 1 && offset <= 7);
    const paid = (paidDates.get(id) ?? []).some(at => dayIndex(at) - signupDay >= 0 && dayIndex(at) - signupDay <= 30);
    steps.set(id, !first ? 'signedUp' : !back ? 'firstAction' : paid ? 'paid' : 'cameBack');
  }
  return steps;
}

describe('activation funnel against a real database', () => {
  it('counts the funnel and lists its drill-downs the way direct queries do, for all signups and legit only', async () => {
    await seedCohort();
    const window = { start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-06-16T00:00:00Z') };
    const createdWindow = { createdFrom: window.start.toISOString(), createdTo: window.end.toISOString() };
    const options = { now: NOW, deadlineMs: 20_000 };
    const cutoff = new Date(NOW.getTime() - 7 * DAY_MS);

    const suspected = new Set(await signupVerdictUserIds({ ...window, verdict: 'suspected' }, options));
    expect(suspected.size).toBe(12);

    const counted = await User.find({
      createdAt: { $gte: window.start, $lt: window.end },
      isAdmin: { $ne: true },
    }).lean();
    const judged = counted.filter(user => user.createdAt <= cutoff);
    const tooNewIds = counted.filter(user => user.createdAt > cutoff).map(user => String(user._id));
    const stepOf = await expectedSteps(judged);
    expect(judged).toHaveLength(19);

    const all = await getActivationFunnel({ ...query, signups: 'all' }, NOW);
    const legit = await getActivationFunnel({ ...query, signups: 'legit' }, NOW);
    if (all.status !== 'ok' || legit.status !== 'ok') throw new Error('expected an ok funnel');
    expect(legit.window).toEqual(createdWindow);
    expect(all.signups).toBe('all');
    expect(legit.signups).toBe('legit');

    const modes = [
      { mode: 'all', funnel: all, keep: (id: string) => !!id, tooNew: tooNewIds },
      {
        mode: 'legit',
        funnel: legit,
        keep: (id: string) => !suspected.has(id),
        tooNew: tooNewIds.filter(id => !suspected.has(id)),
      },
    ] as const;
    for (const { mode, funnel, keep, tooNew } of modes) {
      const members = [...stepOf].filter(([id]) => keep(id));
      expect(funnel.tooNew, `${mode} tooNew`).toBe(tooNew.length);
      for (const step of USER_FUNNEL_STEP_FILTERS) {
        const index = USER_FUNNEL_STEP_FILTERS.indexOf(step);
        const stopped = members
          .filter(([, at]) => at === step)
          .map(([id]) => id)
          .sort();
        const reached = members.filter(([, at]) => USER_FUNNEL_STEP_FILTERS.indexOf(at) >= index);
        expect(funnel.steps[index], `${mode} / ${step}`).toEqual({
          step,
          reached: reached.length,
          stoppedHere: stopped.length,
        });

        const listed = await listAdminUsers(
          { ...params, ...createdWindow, funnelStep: step, verdict: mode === 'legit' ? 'legit' : undefined },
          viewer,
          { logError: vi.fn() },
          NOW
        );
        expect(listed.users.map(user => String(user.id)).sort(), `list ${mode} / ${step}`).toEqual(stopped);
      }
    }
    expect(all.activationRate.value).toBeCloseTo((all.steps[2].reached / all.steps[0].reached) * 100);

    // The shared classifier agrees with the direct derivation as well.
    for (const step of USER_FUNNEL_STEP_FILTERS) {
      const direct = [...stepOf]
        .filter(([, at]) => at === step)
        .map(([id]) => id)
        .sort();
      expect((await funnelStepUserIds({ ...window, step }, options)).sort(), `classifier / ${step}`).toEqual(direct);
    }
  });

  it('splits users created inside the last 7 days out of every step', async () => {
    await seedCohort();
    const { members, tooNewIds } = await classifyFunnelCohort(
      { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-16T00:00:00Z') },
      { now: NOW, deadlineMs: 20_000, withTooNew: true }
    );
    expect(members).toEqual([]);
    expect(tooNewIds).toHaveLength(1);
  });
});
