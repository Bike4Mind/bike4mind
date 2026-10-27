export type SignupAnomalyConfig = {
  signupBaseline: number;
  apiKeyBaseline: number;
  thresholdMultiplier: number;
  minimumCount: number;
};

export type EmailDomainGroup = {
  domain: string;
  userIds: string[];
  count: number;
  firstCreatedAt: string;
  lastCreatedAt: string;
  apiKeyCount: number;
  likelyAutomated: boolean;
};

export type SignupAnomalySnapshot = {
  since: string;
  until: string;
  signupCount: number;
  apiKeyCount: number;
  signupSpike: boolean;
  apiKeySpike: boolean;
  topDomain: string | null;
  truncated: boolean;
};

export const exceedsSignupBaseline = (count: number, baseline: number, config: SignupAnomalyConfig) =>
  count >= config.minimumCount && count > baseline * config.thresholdMultiplier;

export function groupSignupDomains(
  users: { id: string; email: string | null; createdAt: string }[],
  keys: { userId: string }[],
  config: SignupAnomalyConfig
): EmailDomainGroup[] {
  const keyCounts = new Map<string, number>();
  for (const key of keys) keyCounts.set(key.userId, (keyCounts.get(key.userId) ?? 0) + 1);
  const groups = new Map<string, EmailDomainGroup>();
  for (const user of users) {
    const domain = user.email?.split('@')[1]?.toLowerCase() || '(unknown)';
    const group = groups.get(domain) ?? {
      domain,
      userIds: [],
      count: 0,
      firstCreatedAt: user.createdAt,
      lastCreatedAt: user.createdAt,
      apiKeyCount: 0,
      likelyAutomated: false,
    };
    group.userIds.push(user.id);
    group.count++;
    group.firstCreatedAt = group.firstCreatedAt < user.createdAt ? group.firstCreatedAt : user.createdAt;
    group.lastCreatedAt = group.lastCreatedAt > user.createdAt ? group.lastCreatedAt : user.createdAt;
    group.apiKeyCount += keyCounts.get(user.id) ?? 0;
    group.likelyAutomated = exceedsSignupBaseline(group.count, config.signupBaseline, config);
    groups.set(domain, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}
