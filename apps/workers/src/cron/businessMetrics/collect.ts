import { Agent, ApiKeyUsageLog, Organization, Quest, Session, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
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
type MetricOwner = { ownerType: string; ownerId: string };
type AgentRow = { _id: unknown; userId?: string; organizationId?: string; isSystem?: boolean };
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
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const ACCOUNT_FIELDS = {
  email: 1,
  isAdmin: 1,
  isSynthetic: 1,
  createdAt: 1,
  emailVerified: 1,
  emailVerifiedAt: 1,
  stripeCustomerId: 1,
};
const ORGANIZATION_FIELDS = { userId: 1, stripeCustomerId: 1 };

async function* batches<Row>(rows: AsyncIterable<Row>) {
  let batch: Row[] = [];
  for await (const row of rows) {
    batch.push(row);
    if (batch.length === BATCH_SIZE) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

const sourceCut = (source?: string) =>
  source === 'api' ? 'user' : source === 'cli' || source === 'desktop' ? 'firstParty' : 'unclassified';

// Cache only within this invocation: exclusion changes take effect on the next hourly collection.
function createEligibility(rules: ReturnType<typeof buildExclusionRules>) {
  const loadedUsers = new Set<string>();
  const users = new Set<string>();
  const loadedOrganizations = new Set<string>();
  const organizations = new Map<string, OrganizationRow>();
  const loadedAgents = new Set<string>();
  const agentOwners = new Map<string, MetricOwner>();
  const resolveOwner = (type: string, id: string): MetricOwner | undefined =>
    type === 'Agent' ? agentOwners.get(id) : { ownerType: type, ownerId: id };
  const rememberAccount = (account: Account) => {
    const id = String(account._id);
    loadedUsers.add(id);
    if (exclusionReason(account, rules) === null) users.add(id);
  };
  const loadUsers = async (ids: Iterable<string>) => {
    const candidates = [...new Set(ids)].filter(id => OBJECT_ID_RE.test(id) && !loadedUsers.has(id));
    for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + BATCH_SIZE);
      const accounts = await User.find({ _id: { $in: batch } }, ACCOUNT_FIELDS)
        .read('secondaryPreferred')
        .lean<Account[]>();
      batch.forEach(id => loadedUsers.add(id));
      accounts.forEach(rememberAccount);
    }
  };
  const loadOwners = async (owners: ReadonlyArray<MetricOwner>) => {
    const agentIds = [
      ...new Set(owners.filter(owner => owner.ownerType === 'Agent').map(owner => owner.ownerId)),
    ].filter(id => OBJECT_ID_RE.test(id) && !loadedAgents.has(id));
    for (let offset = 0; offset < agentIds.length; offset += BATCH_SIZE) {
      const batch = agentIds.slice(offset, offset + BATCH_SIZE);
      const rows = await Agent.find({ _id: { $in: batch } }, { userId: 1, organizationId: 1, isSystem: 1 })
        .read('secondaryPreferred')
        .lean<AgentRow[]>();
      batch.forEach(id => loadedAgents.add(id));
      for (const agent of rows) {
        if (agent.isSystem || Boolean(agent.userId) === Boolean(agent.organizationId)) continue;
        const ownerId = agent.organizationId ?? agent.userId;
        if (!ownerId) continue;
        agentOwners.set(String(agent._id), {
          ownerType: agent.organizationId ? 'Organization' : 'User',
          ownerId,
        });
      }
    }
    const resolvedOwners = owners.flatMap(owner => {
      const resolved = resolveOwner(owner.ownerType, owner.ownerId);
      return resolved ? [resolved] : [];
    });
    const organizationIds = [
      ...new Set(resolvedOwners.filter(owner => owner.ownerType === 'Organization').map(owner => owner.ownerId)),
    ].filter(id => OBJECT_ID_RE.test(id) && !loadedOrganizations.has(id));
    for (let offset = 0; offset < organizationIds.length; offset += BATCH_SIZE) {
      const batch = organizationIds.slice(offset, offset + BATCH_SIZE);
      const rows = await Organization.find({ _id: { $in: batch } }, ORGANIZATION_FIELDS)
        .read('secondaryPreferred')
        .lean<OrganizationRow[]>();
      batch.forEach(id => loadedOrganizations.add(id));
      rows.forEach(row => organizations.set(String(row._id), row));
    }
    await loadUsers(
      resolvedOwners.flatMap(owner => {
        if (owner.ownerType === 'User') return [owner.ownerId];
        const organization = owner.ownerType === 'Organization' ? organizations.get(owner.ownerId) : undefined;
        return organization ? [organization.userId] : [];
      })
    );
  };
  const allowedOwner = (type: string, id: string) => {
    const owner = resolveOwner(type, id);
    if (!owner) return false;
    if (owner.ownerType === 'User') return users.has(owner.ownerId);
    const organization = owner.ownerType === 'Organization' ? organizations.get(owner.ownerId) : undefined;
    return organization !== undefined && users.has(organization.userId);
  };
  return { users, rememberAccount, loadUsers, loadOwners, allowedOwner, resolveOwner };
}

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
  const eligibility = createEligibility(rules);
  const { users, allowedOwner } = eligibility;
  const accounts = User.find({ createdAt: range }, ACCOUNT_FIELDS)
    .read('secondaryPreferred')
    .lean<Account[]>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const account of accounts) {
    eligibility.rememberAccount(account);
    const id = String(account._id);
    if (!users.has(id) || !account.emailVerified) continue;
    const index = periodIndex(account.createdAt, window);
    const verifiedAt = account.emailVerifiedAt ?? account.createdAt;
    if (index !== null && verifiedAt.getTime() < window.end.getTime() - index * DAY_MS) {
      metrics.add('verifiedSignups', index, 1, [`user:${id}`]);
    }
  }
  const internalKeys = new Set<string>();
  const keys = UserApiKey.find({ productId: { $exists: true, $nin: [null, ''] } }, { _id: 1 })
    .setOptions({ includeDeleted: true })
    .read('secondaryPreferred')
    .lean<Array<{ _id: unknown }>>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const key of keys) internalKeys.add(String(key._id));
  const allowedKey = (id?: string | null) => !id || !internalKeys.has(id);

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
  for await (const allRows of batches(usage)) {
    const rows = allRows.filter(row => periodIndex(row.createdAt, window) !== null);
    await eligibility.loadUsers(rows.map(row => row.userId));
    await eligibility.loadOwners(rows);
    for (const row of rows) {
      if (!users.has(row.userId) || !allowedOwner(row.ownerType, row.ownerId) || !allowedKey(row.apiKeyId)) continue;
      const index = periodIndex(row.createdAt, window);
      if (index === null) continue;
      const labels = [`user:${row.userId}`, `model:${row.model}`];
      const owner = eligibility.resolveOwner(row.ownerType, row.ownerId);
      if (owner?.ownerType === 'Organization') labels.push(`org:${owner.ownerId}`);
      metrics.add('spendUsd', index, row.costUsd, labels);
      metrics.add(`spendUsd:${row.provider}`, index, row.costUsd, labels);
      metrics.add('credits', index, row.creditsCharged, labels);
      if (row.apiKeyId && row.feature === 'completion_api')
        metrics.add(`completions:${sourceCut(row.source)}`, index, 1, labels);
    }
  }
  const requests = ApiKeyUsageLog.find({ timestamp: range }, { userId: 1, keyId: 1, source: 1, timestamp: 1 })
    .read('secondaryPreferred')
    .lean<Array<{ userId: string; keyId: string; source?: string; timestamp: Date }>>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const allRows of batches(requests)) {
    const rows = allRows.filter(row => periodIndex(row.timestamp, window) !== null);
    await eligibility.loadUsers(rows.map(row => row.userId));
    for (const row of rows) {
      if (!users.has(row.userId) || !allowedKey(row.keyId)) continue;
      const index = periodIndex(row.timestamp, window);
      if (index !== null) metrics.add(`requests:${sourceCut(row.source)}`, index, 1, [`user:${row.userId}`]);
    }
  }

  const apiSessions = new Set<string>();
  const excludedSessions = new Set<string>();
  // Resolve only sessions referenced by this window. An old API session can receive a new message.
  const questSessions = Quest.find({ type: 'message', timestamp: range }, { sessionId: 1 })
    .read('secondaryPreferred')
    .lean<Array<{ sessionId?: string }>>()
    .cursor({ batchSize: BATCH_SIZE });
  const seenSessions = new Set<string>();
  for await (const batch of batches(questSessions)) {
    const ids = [
      ...new Set(
        batch
          .map(quest => quest.sessionId)
          .filter((id): id is string => !!id && OBJECT_ID_RE.test(id) && !seenSessions.has(id))
      ),
    ];
    if (ids.length === 0) continue;
    ids.forEach(id => seenSessions.add(id));
    const sessions = await Session.find({ _id: { $in: ids }, 'origin.channel': 'api' }, { 'origin.apiKeyId': 1 })
      .read('secondaryPreferred')
      .lean<Array<{ _id: unknown; origin?: { apiKeyId?: string } }>>();
    for (const session of sessions) {
      apiSessions.add(String(session._id));
      if (!allowedKey(session.origin?.apiKeyId)) excludedSessions.add(String(session._id));
    }
  }
  const activity = await collectActivity(start, BATCH_SIZE, window.end, apiSessions, undefined, undefined, {
    include: (at, source) => source !== 'system' && periodIndex(at, window) !== null,
    excludedApiKeyIds: internalKeys,
    excludedSessionIds: excludedSessions,
  });
  await eligibility.loadUsers(activity.userDays.keys());
  for (const [userId, days] of activity.userDays) {
    if (!users.has(userId)) continue;
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
  for await (const batch of batches(payments)) {
    const charges = batch
      .filter(event => event.type === 'charge.succeeded')
      .map(event => ({
        charge: event.data.object,
        createdAt: new Date(event.created * 1000),
      }));
    const customerIds = [
      ...new Set(
        charges
          .map(({ charge }) => (typeof charge.customer === 'string' ? charge.customer : charge.customer?.id))
          .filter((id): id is string => !!id)
      ),
    ];
    const customers = new Map<string, string>();
    if (customerIds.length > 0) {
      const [accounts, organizations] = await Promise.all([
        User.find({ stripeCustomerId: { $in: customerIds } }, ACCOUNT_FIELDS)
          .read('secondaryPreferred')
          .lean<Account[]>(),
        Organization.find({ stripeCustomerId: { $in: customerIds } }, ORGANIZATION_FIELDS)
          .read('secondaryPreferred')
          .lean<OrganizationRow[]>(),
      ]);
      accounts.forEach(eligibility.rememberAccount);
      const owners = organizations.map(organization => ({
        ownerType: 'Organization',
        ownerId: String(organization._id),
      }));
      await eligibility.loadOwners(owners);
      for (const account of accounts) {
        if (account.stripeCustomerId && users.has(String(account._id)))
          customers.set(account.stripeCustomerId, `user:${String(account._id)}`);
      }
      for (const organization of organizations) {
        if (organization.stripeCustomerId && allowedOwner('Organization', String(organization._id)))
          customers.set(organization.stripeCustomerId, `org:${String(organization._id)}`);
      }
    }
    for (const { charge, createdAt } of charges) {
      if (seenCharges.has(charge.id) || !charge.paid) continue;
      seenCharges.add(charge.id);
      const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
      const customer = customerId ? customers.get(customerId) : undefined;
      const index = periodIndex(createdAt, window);
      if (!customer || index === null) continue;
      // Keep minor units and currencies separate: no implicit FX conversion or two-decimal assumption.
      metrics.add(`revenueMinor:${charge.currency}`, index, charge.amount, [customer]);
    }
  }

  const subscribers = new Set<string>();
  const subscriptions = Subscription.find(
    { source: { $ne: 'admin_grant' }, status: 'active', periodEndsAt: { $gt: new Date() } },
    { ownerType: 1, ownerId: 1 }
  )
    .read('primary')
    .lean<Array<{ ownerType: string; ownerId: string }>>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const batch of batches(subscriptions)) {
    await eligibility.loadOwners(batch);
    for (const subscription of batch) {
      if (allowedOwner(subscription.ownerType, subscription.ownerId))
        subscribers.add(`${subscription.ownerType}:${subscription.ownerId}`);
    }
  }
  return {
    metrics: metrics.result(),
    subscribers: subscribers.size,
  };
}
