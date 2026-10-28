import {
  DISALLOWED_SIGNUP_RULE_DOMAINS,
  personalEmailProviders,
  regionalPersonalEmailProviders,
  isEmailInDomains,
  parseInternalStaffDomains,
  settingsMap,
} from '@bike4mind/common';
import type { IAdminSettingsRepository, IUserRepository, SignupProtection } from '@bike4mind/common';
import { detectSignupBurst, signupDomain } from './signupBurstDetector';
import { blockedDomainsFrom } from './disposableEmail';
import { domainHoldReason } from './domainIntelligence';

/** Never held. The disposable-list refresh job also drops these from the upstream lists. */
export const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  ...DISALLOWED_SIGNUP_RULE_DOMAINS,
  ...personalEmailProviders,
  ...regionalPersonalEmailProviders,
]);

export async function protectSignupCredits(
  userId: string,
  adapters: {
    users: IUserRepository;
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames'>;
    signupProtection?: SignupProtection;
  }
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
    'enableDomainIntelligence',
    'holdSignupsFromDomainsYoungerThanDays',
    'domainIntelligenceTimeoutMs',
    'blockedEmailDomains',
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
    isEmailInDomains(user.email, new Set(parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS))) ||
    (await repository.isOrganizationDomain(user.email))
  )
    return false;

  if (existing) return (await repository.findReview(domain))?.status !== 'released';
  if (protection.mode === 'enforce') return false;

  const threshold = settingsMap.signupBurstThreshold.schema.parse(valueOf('signupBurstThreshold') ?? 5);
  const hours = settingsMap.signupBurstWindowHours.schema.parse(valueOf('signupBurstWindowHours') ?? 6);
  const now = new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  // OTC proves ownership before persisting emailVerified; retries keep the original event time.
  const verifiedAt = user.emailVerifiedAt ?? now;
  if (verifiedAt < since || (user.createdAt && user.createdAt < since)) return false;

  const hold = async (reason: string, signupCount: number, signups: { userId: string; email: string }[]) => {
    const review = {
      domain,
      status: 'held_pending_review' as const,
      reason,
      triggeredAt: now,
      cohortUserIds: signups.map(signup => signup.userId),
      sampleEmails: signups.slice(0, 5).map(signup => signup.email),
      signupCount,
    };
    const created = await repository.createHold(review);
    if (created && protection.notifyHold) await protection.notifyHold(review);
    // A simultaneous admin release wins over this detector's stale snapshot.
    return (await repository.findReview(domain))?.status !== 'released';
  };

  // Independent of signupBurstAutoHold, which only governs the burst detector below.
  if (settingsMap.enableDomainIntelligence.schema.parse(valueOf('enableDomainIntelligence') ?? true)) {
    const reason = await domainHoldReason(user.email, {
      repository,
      youngerThanDays: settingsMap.holdSignupsFromDomainsYoungerThanDays.schema.parse(
        valueOf('holdSignupsFromDomainsYoungerThanDays') ?? 30
      ),
      timeoutMs: settingsMap.domainIntelligenceTimeoutMs.schema.parse(valueOf('domainIntelligenceTimeoutMs') ?? 2000),
      adminBlockedDomains: blockedDomainsFrom(valueOf('blockedEmailDomains')),
    });
    if (reason) return hold(reason, 1, [{ userId, email: user.email }]);
  }

  if (!autoHold) return false;
  await repository.observe({ userId, email: user.email, domain, verifiedAt });
  const cohort = await repository.recent(domain, since);
  const verdict = detectSignupBurst(cohort, { domain, threshold, since });
  if (!verdict.suspicious) return false;
  return hold(verdict.reason, verdict.signupCount, cohort);
}
