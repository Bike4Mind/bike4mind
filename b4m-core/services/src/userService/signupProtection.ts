import {
  DISALLOWED_SIGNUP_RULE_DOMAINS,
  personalEmailProviders,
  regionalPersonalEmailProviders,
  isEmailInDomains,
  settingsMap,
} from '@bike4mind/common';
import type { IAdminSettingsRepository, IUserRepository, SignupProtection } from '@bike4mind/common';
import { detectSignupBurst, signupDomain } from './signupBurstDetector';

const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  ...DISALLOWED_SIGNUP_RULE_DOMAINS,
  ...personalEmailProviders,
  ...regionalPersonalEmailProviders,
]);

export async function protectSignupCredits(
  userId: string,
  adapters: { users: IUserRepository; adminSettings: IAdminSettingsRepository; signupProtection?: SignupProtection }
): Promise<boolean> {
  const protection = adapters.signupProtection;
  if (!protection) return false;
  const user = await adapters.users.findById(userId);
  if (!user?.email) return false;
  const domain = signupDomain(user.email);
  if (!domain) return false;
  const repository = protection.repository;
  const existing = await repository.findReview(domain);

  const settings = await adapters.adminSettings.findBySettingNames([
    'signupBurstThreshold',
    'signupBurstWindowHours',
    'signupBurstAutoHold',
    'syntheticUserEmailDomains',
  ]);
  const valueOf = (name: string) => settings.find(setting => setting.settingName === name)?.settingValue;
  const autoHold = settingsMap.signupBurstAutoHold.schema.parse(valueOf('signupBurstAutoHold') ?? false);
  const synthetic = settingsMap.syntheticUserEmailDomains.schema.parse(valueOf('syntheticUserEmailDomains') ?? '');
  const syntheticDomains = new Set(
    synthetic
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean)
  );
  if (
    isEmailInDomains(user.email, PUBLIC_MAILBOX_DOMAINS) ||
    isEmailInDomains(user.email, syntheticDomains) ||
    (await repository.isOrganizationDomain(user.email))
  )
    return false;

  if (existing) return existing.status !== 'released';
  if (!autoHold || protection.mode === 'enforce') return false;

  const threshold = settingsMap.signupBurstThreshold.schema.parse(valueOf('signupBurstThreshold') ?? 5);
  const hours = settingsMap.signupBurstWindowHours.schema.parse(valueOf('signupBurstWindowHours') ?? 6);
  const now = new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  // OTC proves ownership before persisting emailVerified; retries keep the original event time.
  const verifiedAt = user.emailVerifiedAt ?? now;
  if (verifiedAt < since || (user.createdAt && user.createdAt < since)) return false;
  await repository.observe({ userId, email: user.email, domain, verifiedAt });
  const cohort = await repository.recent(domain, since);
  const verdict = detectSignupBurst(cohort, { domain, threshold, since });
  if (!verdict.suspicious) return false;
  const review = {
    domain,
    status: 'held_pending_review' as const,
    reason: verdict.reason,
    triggeredAt: now,
    cohortUserIds: cohort.map(signup => signup.userId),
    sampleEmails: cohort.slice(0, 5).map(signup => signup.email),
    signupCount: verdict.signupCount,
  };
  const created = await repository.createHold(review);
  if (created && protection.notifyHold) await protection.notifyHold(review);
  // A simultaneous admin release wins over this detector's stale snapshot.
  return (await repository.findReview(domain))?.status !== 'released';
}
