import { adminSettingsRepository, User, UserApiKey } from '@bike4mind/database';
import { exceedsSignupBaseline, groupSignupDomains } from '@client/app/utils/signupAnomaly';
import { DOMAIN_SIGNUP_SIGNALS } from '@client/app/utils/signupSignals';
import { classifyDomainCohorts } from './signupClassifier';

export const SIGNUP_SCAN_LIMIT = 5000;
export const KEY_SCAN_LIMIT = 10000;

export async function getSignupAnomalySnapshot(now = new Date()) {
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const config = await adminSettingsRepository.getSettingsValue('signupAnomaly');
  if (!config) throw new Error('Signup anomaly settings unavailable');
  const [users, keys] = await Promise.all([
    User.find({ createdAt: { $gte: since, $lt: now } })
      .select('_id email createdAt')
      .hint({ createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(SIGNUP_SCAN_LIMIT + 1)
      .maxTimeMS(2000)
      .lean(),
    UserApiKey.find({ createdAt: { $gte: since, $lt: now } })
      .select('userId')
      .hint({ createdAt: 1 })
      .limit(KEY_SCAN_LIMIT + 1)
      .maxTimeMS(2000)
      .lean(),
  ]);
  const groups = groupSignupDomains(
    users.slice(0, SIGNUP_SCAN_LIMIT).map(user => ({
      id: String(user._id),
      email: user.email,
      createdAt: new Date(user.createdAt).toISOString(),
    })),
    keys.slice(0, KEY_SCAN_LIMIT)
  );
  return {
    since: since.toISOString(),
    until: now.toISOString(),
    signupCount: Math.min(users.length, SIGNUP_SCAN_LIMIT),
    apiKeyCount: Math.min(keys.length, KEY_SCAN_LIMIT),
    signupSpike: exceedsSignupBaseline(users.length, config.signupBaseline, config),
    apiKeySpike: exceedsSignupBaseline(keys.length, config.apiKeyBaseline, config),
    topDomain: groups[0]?.domain ?? null,
    truncated: users.length > SIGNUP_SCAN_LIMIT || keys.length > KEY_SCAN_LIMIT,
  };
}

/** Signups either side of the shown cohort that the classifier also sees, so a run cut by the filter still counts. */
export const DOMAIN_CONTEXT_MS = 24 * 60 * 60 * 1000;

type CohortRow = { _id: unknown; email?: string | null; createdAt: Date };
const toMember = (user: CohortRow) => ({
  id: String(user._id),
  email: user.email ?? null,
  createdAt: new Date(user.createdAt),
});

/**
 * Signups around the cohort's time span. The table's cohort is usually one hour (a chart bar or "Review
 * cluster"), where cadence can never fire; classifying it alongside this context keeps it in line with the chart.
 */
async function loadDomainContext(cohort: ReturnType<typeof toMember>[]) {
  if (cohort.length === 0) return [];
  const times = cohort.map(user => user.createdAt.getTime());
  const rows = await User.find({
    createdAt: {
      $gte: new Date(Math.min(...times) - DOMAIN_CONTEXT_MS),
      $lte: new Date(Math.max(...times) + DOMAIN_CONTEXT_MS),
    },
  })
    .select('_id email createdAt')
    .hint({ createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(SIGNUP_SCAN_LIMIT)
    .maxTimeMS(2000)
    .lean();
  return rows.map(toMember);
}

/** Domain groups for the review table, flagged by the same classifier that feeds the signup chart. */
export async function getDomainGroups(users: CohortRow[]) {
  const cohort = users.map(toMember);
  const [keys, context] = await Promise.all([
    UserApiKey.find({ userId: { $in: cohort.map(user => user.id) } })
      .select('userId')
      .hint({ userId: 1, status: 1 })
      .limit(KEY_SCAN_LIMIT + 1)
      .maxTimeMS(2000)
      .lean(),
    loadDomainContext(cohort),
  ]);
  const signalsById = classifyDomainCohorts([
    ...new Map([...context, ...cohort].map(user => [user.id, user])).values(),
  ]);
  const groups = groupSignupDomains(
    cohort.map(user => ({ ...user, createdAt: user.createdAt.toISOString() })),
    keys.slice(0, KEY_SCAN_LIMIT)
  ).map(group => {
    const found = new Set(group.userIds.flatMap(id => [...(signalsById.get(id) ?? [])]));
    return { ...group, signals: DOMAIN_SIGNUP_SIGNALS.filter(signal => found.has(signal)) };
  });
  return { groups, keysTruncated: keys.length > KEY_SCAN_LIMIT };
}
