import { describe, expect, it } from 'vitest';
import {
  adminSubscriptionsSort,
  buildAdminSubscriptionsMatch,
  classifySearch,
  planOf,
  subscriptionPlanCatalog,
  viewConditions,
  type PlanCatalog,
} from './adminSubscriptionsQuery';

const now = new Date('2026-10-27T12:00:00.000Z');
const DAY = 86_400_000;
const catalog: PlanCatalog = new Map([
  ['price_pro_m', { name: 'Pro', interval: 'monthly' as const }],
  ['price_pro_y', { name: 'Pro Yearly', interval: 'yearly' as const }],
  ['price_team', { name: 'Team', interval: 'monthly' as const }],
]);
const context = { now, catalog };
const TERMINAL = ['canceled', 'incomplete_expired'];

const conditionsOf = (match: Record<string, unknown>) => (match.$and ?? []) as Record<string, unknown>[];

describe('classifySearch', () => {
  it.each([
    ['sub_1Abc', 'subscriptionId'],
    ['admin_grant_1234', 'subscriptionId'],
    ['cus_abc', 'customerId'],
    ['0123456789abcdef01234567', 'objectId'],
    ['0123456789ABCDEF01234567', 'objectId'],
    ['0123456789abcdef0123456', 'text'],
    ['jane@example.com', 'text'],
    ['Acme Corp', 'text'],
  ] as const)('%s is %s', (search, kind) => {
    expect(classifySearch(search)).toBe(kind);
  });
});

describe('buildAdminSubscriptionsMatch', () => {
  it('matches everything for an empty filter', () => {
    expect(buildAdminSubscriptionsMatch({}, context)).toEqual({});
  });

  it('unwraps a single condition', () => {
    expect(buildAdminSubscriptionsMatch({ ownerType: 'User' }, context)).toEqual({ ownerType: 'User' });
  });

  it('filters status with $in', () => {
    expect(buildAdminSubscriptionsMatch({ status: ['active', 'past_due'] }, context)).toEqual({
      status: { $in: ['active', 'past_due'] },
    });
  });

  it('filters known plans by price id', () => {
    expect(buildAdminSubscriptionsMatch({ plan: ['price_pro_m', 'price_team'] }, context)).toEqual({
      priceId: { $in: ['price_pro_m', 'price_team'] },
    });
  });

  it('treats the unknown plan as every price outside the catalog', () => {
    expect(buildAdminSubscriptionsMatch({ plan: ['unknown'] }, context)).toEqual({
      priceId: { $nin: ['price_pro_m', 'price_pro_y', 'price_team'] },
    });
  });

  it('ORs known plans with the unknown plan', () => {
    expect(buildAdminSubscriptionsMatch({ plan: ['price_team', 'unknown'] }, context)).toEqual({
      $or: [{ priceId: { $in: ['price_team'] } }, { priceId: { $nin: ['price_pro_m', 'price_pro_y', 'price_team'] } }],
    });
  });

  it('maps an interval to the price ids of that interval', () => {
    expect(buildAdminSubscriptionsMatch({ interval: 'yearly' }, context)).toEqual({
      priceId: { $in: ['price_pro_y'] },
    });
    expect(buildAdminSubscriptionsMatch({ interval: 'yearly' }, { now, catalog: new Map() })).toEqual({
      priceId: { $in: [] },
    });
  });

  it('filters owner type and source', () => {
    expect(buildAdminSubscriptionsMatch({ ownerType: 'Organization', source: 'admin_grant' }, context)).toEqual({
      $and: [{ ownerType: 'Organization' }, { source: 'admin_grant' }],
    });
  });

  it('builds the renewal windows over non-terminal rows', () => {
    expect(buildAdminSubscriptionsMatch({ renews: 'next7' }, context)).toEqual({
      status: { $nin: TERMINAL },
      periodEndsAt: { $gte: now, $lt: new Date(now.getTime() + 7 * DAY) },
    });
    expect(buildAdminSubscriptionsMatch({ renews: 'next30' }, context)).toEqual({
      status: { $nin: TERMINAL },
      periodEndsAt: { $gte: now, $lt: new Date(now.getTime() + 30 * DAY) },
    });
  });

  it('reads overdue as a non-terminal row whose period already ended', () => {
    expect(buildAdminSubscriptionsMatch({ renews: 'overdue' }, context)).toEqual({
      status: { $nin: TERMINAL },
      periodEndsAt: { $lt: now },
    });
  });

  it('puts the resolved search condition first and ANDs the rest', () => {
    const searchCondition = { subscriptionId: 'sub_1' };
    const conditions = conditionsOf(
      buildAdminSubscriptionsMatch({ status: ['active'], source: 'stripe' }, { ...context, searchCondition })
    );
    expect(conditions).toEqual([searchCondition, { status: { $in: ['active'] } }, { source: 'stripe' }]);
  });
});

describe('viewConditions', () => {
  it('defines the four built-in views', () => {
    expect(viewConditions(now)).toEqual({
      paying: { source: 'stripe', status: { $in: ['active', 'past_due'] } },
      pastDue: { status: { $in: ['past_due', 'unpaid', 'incomplete'] } },
      comped: { source: 'admin_grant', status: { $nin: TERMINAL } },
      churned: { status: 'canceled', canceledAt: { $gte: new Date(now.getTime() - 30 * DAY) } },
    });
  });
});

describe('adminSubscriptionsSort', () => {
  it('breaks ties on _id in the same direction', () => {
    expect(adminSubscriptionsSort('createdAt', 'desc')).toEqual({ createdAt: -1, _id: -1 });
    expect(adminSubscriptionsSort('periodEndsAt', 'asc')).toEqual({ periodEndsAt: 1, _id: 1 });
  });
});

describe('planOf', () => {
  it('names a catalog price', () => {
    expect(planOf('price_pro_y', catalog)).toEqual({ priceId: 'price_pro_y', name: 'Pro Yearly', interval: 'yearly' });
  });

  it('keeps the price id of an unknown price with no name', () => {
    expect(planOf('price_old', catalog)).toEqual({ priceId: 'price_old', name: null, interval: null });
  });

  it('returns nulls for a missing price id', () => {
    expect(planOf('', catalog)).toEqual({ priceId: null, name: null, interval: null });
    expect(planOf(undefined, catalog)).toEqual({ priceId: null, name: null, interval: null });
  });
});

describe('subscriptionPlanCatalog', () => {
  it('skips plans whose env price id is empty', () => {
    expect([...subscriptionPlanCatalog().keys()].every(Boolean)).toBe(true);
  });
});

describe('buildAdminSubscriptionsMatch cancel filter', () => {
  it('reads scheduled as a non-terminal row with a cancel requested', () => {
    expect(buildAdminSubscriptionsMatch({ cancel: 'scheduled' }, context)).toEqual({
      status: { $nin: TERMINAL },
      canceledAt: { $ne: null },
    });
  });

  it('reads last30 as canceledAt inside the churn window, on any status', () => {
    expect(buildAdminSubscriptionsMatch({ cancel: 'last30' }, context)).toEqual({
      canceledAt: { $gte: new Date(now.getTime() - 30 * DAY) },
    });
  });

  it('builds the churned view condition from status canceled plus last30', () => {
    const { churned } = viewConditions(now);
    expect(conditionsOf(buildAdminSubscriptionsMatch({ status: ['canceled'], cancel: 'last30' }, context))).toEqual([
      { status: { $in: [churned.status] } },
      { canceledAt: churned.canceledAt },
    ]);
  });
});
