import { ApiKeyUsageLog, Organization, Session, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { Subscription } from '@server/models/Subscription';
import {
  buildExclusionRules,
  exclusionReason,
  type UserRecord,
} from '@bike4mind/server-utils/analytics/externalActiveUsers';
import { collectActivity } from '@bike4mind/server-utils/analytics/externalActiveUsersReport';
import {
  createMetricAccumulator,
  DAY_MS,
  periodIndex,
  type ComparisonWindow,
} from '@bike4mind/server-utils/analytics/businessMetricAnomalies';
import { getStripe } from '@bike4mind/server-utils/integrations/stripe/stripe';

type Account = UserRecord & {
  _id: unknown;
  createdAt: Date;
  emailVerified: boolean;
  emailVerifiedAt?: Date | null;
  stripeCustomerId?: string;
};
type OrganizationRow = { _id: unknown; userId: string; stripeCustomerId?: string };
type Usage = {
  userId: string;
  ownerId: string;
  ownerType: string;
  provider: string;
  model: string;
  createdAt: Date;
  costUsd: number;
  creditsCharged: number;
  source?: string;
  apiKeyId?: string;
  feature: string;
};
const BATCH_SIZE = 500;

export async function collectBusinessMetrics(window: ComparisonWindow) {
  const start = new Date(window.end.getTime() - 7 * DAY_MS - window.duration);
  const range = { $gte: start, $lt: window.end };
  const rules = buildExclusionRules(
    process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS,
    new RegExp(process.env.ANALYTICS_TEST_PATTERN || '(?!)', 'i')
  );
  const metrics = createMetricAccumulator();
  for (const name of [
    'verifiedSignups',
    'activeUsers',
    'spendUsd',
    'credits',
    'requests:user',
    'requests:firstParty',
    'completions:user',
    'completions:firstParty',
  ])
    metrics.ensure(name);
  const users = new Set<string>();
  const customers = new Map<string, string>();
  const accounts = User.find(
    {},
    { email: 1, isAdmin: 1, isSynthetic: 1, createdAt: 1, emailVerified: 1, emailVerifiedAt: 1, stripeCustomerId: 1 }
  )
    .read('secondaryPreferred')
    .lean<Account[]>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const account of accounts) {
    if (exclusionReason(account, rules) !== null) continue;
    const id = String(account._id);
    users.add(id);
    if (account.stripeCustomerId) customers.set(account.stripeCustomerId, `user:${id}`);
    if (!account.emailVerified) continue;
    const index = periodIndex(account.createdAt, window);
    if (index !== null) metrics.add('verifiedSignups', index, 1, [`user:${id}`]);
  }
  const organizations = new Set<string>();
  const orgs = Organization.find({}, { userId: 1, stripeCustomerId: 1 })
    .read('secondaryPreferred')
    .lean<OrganizationRow[]>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const organization of orgs) {
    if (!users.has(organization.userId)) continue;
    const id = String(organization._id);
    organizations.add(id);
    if (organization.stripeCustomerId) customers.set(organization.stripeCustomerId, `org:${id}`);
  }
  const internalKeys = new Set<string>();
  const keys = UserApiKey.find({ productId: { $exists: true, $nin: [null, ''] } }, { _id: 1 })
    .setOptions({ includeDeleted: true })
    .read('secondaryPreferred')
    .lean<Array<{ _id: unknown }>>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const key of keys) internalKeys.add(String(key._id));
  const allowedKey = (id?: string | null) => !id || !internalKeys.has(id);
  const allowedOwner = (type: string, id: string) =>
    type === 'Organization' ? organizations.has(id) : type === 'User' && users.has(id);

  const usage = UsageEvent.find(
    { createdAt: range, source: { $ne: 'system' } },
    {
      userId: 1,
      ownerId: 1,
      ownerType: 1,
      provider: 1,
      model: 1,
      createdAt: 1,
      costUsd: 1,
      creditsCharged: 1,
      source: 1,
      apiKeyId: 1,
      feature: 1,
    }
  )
    .read('secondaryPreferred')
    .lean<Usage[]>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const row of usage) {
    if (!users.has(row.userId) || !allowedOwner(row.ownerType, row.ownerId) || !allowedKey(row.apiKeyId)) continue;
    const index = periodIndex(row.createdAt, window);
    if (index === null) continue;
    const labels = [`user:${row.userId}`, `model:${row.model}`];
    if (row.ownerType === 'Organization') labels.push(`org:${row.ownerId}`);
    metrics.add('spendUsd', index, row.costUsd, labels);
    metrics.add(`spendUsd:${row.provider}`, index, row.costUsd, labels);
    metrics.add('credits', index, row.creditsCharged, labels);
    if (row.apiKeyId && row.feature === 'completion_api')
      metrics.add(
        `completions:${row.source === 'api' ? 'user' : row.source === 'cli' || row.source === 'desktop' ? 'firstParty' : 'unclassified'}`,
        index,
        1,
        labels
      );
  }
  const requests = ApiKeyUsageLog.find({ timestamp: range }, { userId: 1, keyId: 1, source: 1, timestamp: 1 })
    .read('secondaryPreferred')
    .lean<Array<{ userId: string; keyId: string; source?: string; timestamp: Date }>>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const row of requests) {
    if (!users.has(row.userId) || !allowedKey(row.keyId)) continue;
    const index = periodIndex(row.timestamp, window);
    if (index !== null)
      metrics.add(
        `requests:${row.source === 'api' ? 'user' : row.source === 'cli' || row.source === 'desktop' ? 'firstParty' : 'unclassified'}`,
        index,
        1,
        [`user:${row.userId}`]
      );
  }

  const apiSessions = new Set<string>();
  const excludedSessions = new Set<string>();
  const sessions = Session.find({ 'origin.channel': 'api' }, { _id: 1, 'origin.apiKeyId': 1 })
    .read('secondaryPreferred')
    .lean<Array<{ _id: unknown; origin?: { apiKeyId?: string } }>>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const session of sessions) {
    apiSessions.add(String(session._id));
    if (!allowedKey(session.origin?.apiKeyId)) excludedSessions.add(String(session._id));
  }
  const activity = await collectActivity(start, BATCH_SIZE, window.end, apiSessions, users, undefined, {
    include: (at, source) => source !== 'system' && periodIndex(at, window) !== null,
    excludedApiKeyIds: internalKeys,
    excludedSessionIds: excludedSessions,
  });
  for (const [userId, days] of activity.userDays) {
    for (const day of days) {
      const at = new Date(day * DAY_MS + window.duration - 1);
      const index = periodIndex(at, window);
      if (index !== null) metrics.add('activeUsers', index, 1, [`user:${userId}`]);
    }
  }

  // Stripe events retain the payment timestamp; invoice creation time can precede payment by weeks.
  const payments = getStripe().events.list({
    type: 'charge.succeeded',
    created: { gte: Math.floor(start.getTime() / 1000), lt: Math.floor(window.end.getTime() / 1000) },
    limit: 100,
  });
  const seenCharges = new Set<string>();
  for await (const event of payments) {
    if (event.type !== 'charge.succeeded') continue;
    const charge = event.data.object;
    if (seenCharges.has(charge.id) || !charge.paid) continue;
    seenCharges.add(charge.id);
    const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
    const customer = customerId ? customers.get(customerId) : undefined;
    const index = periodIndex(new Date(event.created * 1000), window);
    if (!customer || index === null) continue;
    // Keep minor units and currencies separate: no implicit FX conversion or two-decimal assumption.
    metrics.add(`revenueMinor:${charge.currency}`, index, charge.amount, [customer]);
  }

  const subscribers = new Set<string>();
  const subscriptions = Subscription.find(
    { source: { $ne: 'admin_grant' }, status: 'active', periodEndsAt: { $gt: new Date() } },
    { ownerType: 1, ownerId: 1 }
  )
    .read('primary')
    .lean<Array<{ ownerType: string; ownerId: string }>>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const subscription of subscriptions) {
    if (allowedOwner(subscription.ownerType, subscription.ownerId))
      subscribers.add(`${subscription.ownerType}:${subscription.ownerId}`);
  }
  return {
    metrics: metrics.result(),
    subscribers: subscribers.size,
    subscriberContributors: [...subscribers].slice(0, 5).map(label => ({ label, value: 1 })),
  };
}
