import { adminSettingsRepository, User, UserApiKey } from '@bike4mind/database';
import { exceedsSignupBaseline, groupSignupDomains } from '@client/app/utils/signupAnomaly';

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
    keys.slice(0, KEY_SCAN_LIMIT),
    config
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

export async function getDomainGroups(users: { _id: unknown; email: string | null; createdAt: Date }[]) {
  const config = await adminSettingsRepository.getSettingsValue('signupAnomaly');
  if (!config) throw new Error('Signup anomaly settings unavailable');
  const keys = await UserApiKey.find({ userId: { $in: users.map(user => String(user._id)) } })
    .select('userId')
    .hint({ userId: 1, status: 1 })
    .limit(KEY_SCAN_LIMIT + 1)
    .maxTimeMS(2000)
    .lean();
  return {
    groups: groupSignupDomains(
      users.map(user => ({
        id: String(user._id),
        email: user.email,
        createdAt: new Date(user.createdAt).toISOString(),
      })),
      keys.slice(0, KEY_SCAN_LIMIT),
      config
    ),
    keysTruncated: keys.length > KEY_SCAN_LIMIT,
  };
}
