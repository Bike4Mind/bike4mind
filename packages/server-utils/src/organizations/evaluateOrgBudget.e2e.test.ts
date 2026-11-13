import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Organization, OrgAlertNotificationModel, User, mongoose } from '@bike4mind/database';
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { clearOrgBudgetAlertCache, evaluateOrgBudget } from './evaluateOrgBudget';

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

const orgId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const NOV = new Date('2026-11-15T00:00:00Z');
const DEC = new Date('2026-12-02T00:00:00Z');

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  process.env.APP_URL = 'https://app.example.com';
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await OrgAlertNotificationModel.ensureIndexes();
  clearOrgBudgetAlertCache();
  publish.mockReset();
  await User.collection.insertOne({ _id: ownerId, email: 'owner@example.com' });
  await Organization.collection.insertOne({
    _id: orgId,
    name: 'Acme',
    personal: false,
    userId: ownerId.toHexString(),
    budgetAlerts: { enabled: true, monthlyBudgetCredits: 1000, percentThresholds: [90, 80], lowBalanceCredits: 500 },
    userDetails: [
      { id: 'a', usedCredits: 850, periodStart: new Date('2026-11-01T00:00:00Z') },
      // Last month's counter reads as 0; counted, it would cross 90% too.
      { id: 'b', usedCredits: 5000, periodStart: new Date('2026-10-01T00:00:00Z') },
    ],
  });
});

const claims = (filter: Record<string, unknown> = {}) =>
  OrgAlertNotificationModel.find({ organizationId: orgId.toHexString(), ...filter }).lean();
const evaluate = (balanceAfter: number, now = NOV) =>
  evaluateOrgBudget({ organizationId: orgId.toHexString(), balanceAfter }, now);

describe('evaluateOrgBudget', () => {
  it('fires each crossed percent threshold once per period', async () => {
    await evaluate(2000);

    expect((await claims()).map(c => [c.kind, c.scope, c.periodKey])).toEqual([
      ['budget_threshold', 'pct:80', '2026-11'],
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0].subject).toContain('80% of monthly credit budget used');

    clearOrgBudgetAlertCache();
    await evaluate(1900);
    expect(await claims()).toHaveLength(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('fires again in the next period', async () => {
    await evaluate(2000);
    await Organization.collection.updateOne(
      { _id: orgId },
      { $set: { userDetails: [{ id: 'a', usedCredits: 820, periodStart: new Date('2026-12-01T00:00:00Z') }] } }
    );
    clearOrgBudgetAlertCache();

    await evaluate(2000, DEC);

    expect((await claims({ scope: 'pct:80' })).map(c => c.periodKey).sort()).toEqual(['2026-11', '2026-12']);
  });

  it('fires the low-balance alert at or below the floor, including an overdrawn pool', async () => {
    await evaluate(-20);

    expect(await claims({ kind: 'low_balance', scope: 'low:500' })).toHaveLength(1);
  });

  it('skips the low-balance check when the balance is unknown', async () => {
    await evaluate(Number.NaN);

    expect(await claims({ kind: 'low_balance' })).toHaveLength(0);
  });

  it('does nothing when alerts are disabled', async () => {
    await Organization.collection.updateOne({ _id: orgId }, { $set: { 'budgetAlerts.enabled': false } });

    await evaluate(0);

    expect(await claims()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('skips percent alerts without a budget', async () => {
    await Organization.collection.updateOne({ _id: orgId }, { $set: { 'budgetAlerts.monthlyBudgetCredits': null } });

    await evaluate(2000);

    expect(await claims()).toHaveLength(0);
  });
});
