import { ApiKeyUsageLog, AuthSessionModel, Organization, User, UserApiKey } from '@bike4mind/database';
import type { AdminSearchResult } from '@client/app/utils/adminEntitySearch';
import { classifyAdminQuery } from './classifyQuery';

const GROUP_LIMIT = 5;
const QUERY_TIMEOUT_MS = 350;
const CI_COLLATION = { locale: 'en', strength: 2 };
const maskEmail = (email: string | null | undefined) => {
  if (!email) return 'No email';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain ?? '***'}`;
};

export async function searchAdminEntities(query: string): Promise<AdminSearchResult[]> {
  const kind = classifyAdminQuery(query);
  // Stored client IPs are lowercase; isIP also accepts uppercase IPv6.
  const ip = query.toLowerCase();
  const prefix = new RegExp(`^${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const keyFilter = kind === 'keyPrefix' ? { keyPrefix: prefix } : kind === 'id' ? { _id: query } : null;
  const keys = keyFilter
    ? await UserApiKey.find(keyFilter)
        .hint(kind === 'id' ? '_id_' : 'keyPrefix_1')
        .select('_id userId name keyPrefix')
        .sort(kind === 'id' ? { _id: 1 } : { keyPrefix: 1 })
        .limit(GROUP_LIMIT)
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .lean()
    : [];
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
  const [sessionRows, usageRows] =
    kind === 'ip'
      ? await Promise.all([
          AuthSessionModel.find({ 'device.ip': ip })
            .hint('auth_session_ip_search')
            .select('userId lastUsedAt -_id')
            .sort({ lastUsedAt: -1 })
            .limit(100)
            .maxTimeMS(QUERY_TIMEOUT_MS)
            .lean(),
          // One row per API user, so a single busy key cannot crowd out other users on the IP.
          ApiKeyUsageLog.aggregate<{ _id: string; last: Date }>(
            [
              { $match: { ipAddress: ip } },
              { $sort: { timestamp: -1 } },
              { $group: { _id: '$userId', last: { $first: '$timestamp' } } },
              { $sort: { last: -1 } },
              { $limit: 100 },
            ],
            { hint: 'api_usage_ip_search', maxTimeMS: QUERY_TIMEOUT_MS }
          ),
        ])
      : [[], []];
  const lastSeen = new Map<string, number>();
  const noteSeen = (id: unknown, at: Date | undefined) => {
    if (!validId(id)) return;
    const time = at ? new Date(at).getTime() : 0;
    lastSeen.set(id, Math.max(lastSeen.get(id) ?? 0, time));
  };
  sessionRows.forEach(row => noteSeen(row.userId, row.lastUsedAt));
  usageRows.forEach(row => noteSeen(row._id, row.last));
  // Newest first; the user query re-sorts by _id, so the order is restored in JS below.
  const recentOwnerIds = [...lastSeen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, GROUP_LIMIT);
  const recencyOrder =
    kind === 'ip'
      ? recentOwnerIds
      : kind === 'keyPrefix'
        ? [...new Set(keys.map(key => key.userId).filter(validId))]
        : null;
  const userFilter =
    kind === 'id'
      ? { _id: query }
      : kind === 'email'
        ? { email: query }
        : kind === 'stripe'
          ? { stripeCustomerId: query }
          : recencyOrder
            ? { _id: { $in: recencyOrder } }
            : null;
  const [users, namedOrganizations, identifiedOrganizations] = await Promise.all([
    userFilter
      ? User.find(userFilter)
          .hint(kind === 'email' ? 'email_ci' : kind === 'stripe' ? 'user_stripeCustomerId' : '_id_')
          .collation(kind === 'email' ? CI_COLLATION : { locale: 'simple' })
          .select('_id name username email')
          .sort({ _id: 1 })
          .limit(GROUP_LIMIT)
          .maxTimeMS(QUERY_TIMEOUT_MS)
          .lean()
      : [],
    kind === 'keyPrefix'
      ? []
      : Organization.find({ name: query })
          .hint('organization_name_ci')
          .collation(CI_COLLATION)
          .select('_id name')
          .sort({ _id: 1 })
          .limit(GROUP_LIMIT)
          .maxTimeMS(QUERY_TIMEOUT_MS)
          .lean(),
    kind === 'id' || kind === 'stripe'
      ? Organization.find(kind === 'id' ? { _id: query } : { stripeCustomerId: query })
          .hint(kind === 'id' ? '_id_' : 'organization_stripeCustomerId')
          .select('_id name')
          .sort({ _id: 1 })
          .limit(GROUP_LIMIT)
          .maxTimeMS(QUERY_TIMEOUT_MS)
          .lean()
      : [],
  ]);
  if (recencyOrder) {
    users.sort((x, y) => recencyOrder.indexOf(String(x._id)) - recencyOrder.indexOf(String(y._id)));
  }
  const organizations = [
    ...new Map([...identifiedOrganizations, ...namedOrganizations].map(org => [String(org._id), org])).values(),
  ].slice(0, GROUP_LIMIT);
  return [
    ...users.map(user => ({
      type: 'user' as const,
      id: String(user._id),
      displayName: user.name || user.username,
      secondary: maskEmail(user.email),
    })),
    ...keys.map(key => ({
      type: 'key' as const,
      id: String(key._id),
      userId: key.userId,
      displayName: key.name || 'API key',
      secondary: `${key.keyPrefix}...`,
    })),
    ...organizations.map(org => ({
      type: 'organization' as const,
      id: String(org._id),
      displayName: org.name,
      secondary: `ID ...${String(org._id).slice(-6)}`,
    })),
  ];
}
