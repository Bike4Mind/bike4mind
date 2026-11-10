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

/**
 * Never held. The disposable-list refresh job also drops these, and PRIVACY_RELAY_DOMAINS in
 * disposableEmail.ts, from the upstream lists.
 */
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

  // An admin release exempts a domain for good. An automated release only pays out the cohort it judged,
  // so the domain stays watched: a signup that still trips a domain-intel hold (a young domain, below)
  // or a burst re-holds it for review instead of being paid.
  const watched =
    existing?.status === 'released' &&
    existing.autoDecision?.policy === 'advisory-decision' &&
    !!repository.reholdWatched;
  if (existing && (!watched || protection.mode === 'enforce'))
    return (await repository.findReview(domain))?.status !== 'released';
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

  const rehold = async (reason: string, signupCount: number, signups: { userId: string; email: string }[]) => {
    const review = {
      domain,
      status: 'held_pending_review' as const,
      reason,
      triggeredAt: now,
      cohortUserIds: signups.map(signup => signup.userId),
      sampleEmails: signups.slice(0, 5).map(signup => signup.email),
      signupCount,
    };
    const reheld = (await repository.reholdWatched?.(review)) ?? false;
    if (reheld && protection.notifyHold) await protection.notifyHold(review);
    // An admin decision since the automated release wins, as with a fresh hold.
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
    if (reason) return (watched ? rehold : hold)(reason, 1, [{ userId, email: user.email }]);
  }

  // A watched domain is checked for bursts whatever signupBurstAutoHold says.
  if (!autoHold && !watched) return false;
  await repository.observe({ userId, email: user.email, domain, verifiedAt });
  const cohort = await repository.recent(domain, since);
  const verdict = detectSignupBurst(cohort, { domain, threshold, since });
  if (!verdict.suspicious) return false;
  if (watched) return rehold(verdict.reason, verdict.signupCount, cohort);
  return hold(verdict.reason, verdict.signupCount, cohort);
}
