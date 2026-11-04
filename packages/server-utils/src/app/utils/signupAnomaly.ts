import type { DomainSignupSignal } from './signupSignals';

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
  /** Domain-cohort signals from server/users/signupClassifier.ts that any account in the group triggered. */
  signals: DomainSignupSignal[];
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

/** The lowercased domain after the last `@`, without a trailing dot; `(unknown)` when there is none. */
export function emailDomain(email: string | null): string {
  const at = email?.lastIndexOf('@') ?? -1;
  return (
    (at >= 0 && email
      ? email
          .slice(at + 1)
          .replace(/\.$/, '')
          .toLowerCase()
      : '') || '(unknown)'
  );
}

/** Groups signups by email domain. Review signals are added by the server's getDomainGroups. */
export function groupSignupDomains(
  users: { id: string; email: string | null; createdAt: string }[],
  keys: { userId: string }[]
): Omit<EmailDomainGroup, 'signals'>[] {
  const keyCounts = new Map<string, number>();
  for (const key of keys) keyCounts.set(key.userId, (keyCounts.get(key.userId) ?? 0) + 1);
  const groups = new Map<string, Omit<EmailDomainGroup, 'signals'>>();
  for (const user of users) {
    const domain = emailDomain(user.email);
    const group = groups.get(domain) ?? {
      domain,
      userIds: [],
      count: 0,
      firstCreatedAt: user.createdAt,
      lastCreatedAt: user.createdAt,
      apiKeyCount: 0,
    };
    group.userIds.push(user.id);
    group.count++;
    group.firstCreatedAt = group.firstCreatedAt < user.createdAt ? group.firstCreatedAt : user.createdAt;
    group.lastCreatedAt = group.lastCreatedAt > user.createdAt ? group.lastCreatedAt : user.createdAt;
    group.apiKeyCount += keyCounts.get(user.id) ?? 0;
    groups.set(domain, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}
