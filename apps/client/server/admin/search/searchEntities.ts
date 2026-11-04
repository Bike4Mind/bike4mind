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
  const ipRows =
    kind === 'ip'
      ? await Promise.all([
          AuthSessionModel.find({ 'device.ip': ip })
            .hint('auth_session_ip_search')
            .select('userId -_id')
            .sort({ lastUsedAt: -1 })
            .limit(100)
            .maxTimeMS(QUERY_TIMEOUT_MS)
            .lean(),
          ApiKeyUsageLog.find({ ipAddress: ip })
            .hint('api_usage_ip_search')
            .select('userId -_id')
            .sort({ timestamp: -1 })
            .limit(100)
            .maxTimeMS(QUERY_TIMEOUT_MS)
            .lean(),
        ])
      : [];
  const ipUserIds = ipRows
    .flat()
    .map(row => row.userId)
    .filter(id => /^[a-f0-9]{24}$/i.test(id));
  const userFilter =
    kind === 'id'
      ? { _id: query }
      : kind === 'email'
        ? { email: query }
        : kind === 'stripe'
          ? { stripeCustomerId: query }
          : kind === 'ip'
            ? { _id: { $in: ipUserIds } }
            : kind === 'keyPrefix'
              ? { _id: { $in: keys.map(key => key.userId) } }
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
