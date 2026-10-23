import type { SignupObservation } from '@bike4mind/common';
import { emailDomainOf } from '@bike4mind/common';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

export const signupDomain = (email: string): string | null =>
  registrableDomain(emailDomainOf(email), { allowPrivateDomains: true });

export type SignupBurstVerdict = { suspicious: boolean; reason: string; signupCount: number };

export function detectSignupBurst(
  signups: readonly SignupObservation[],
  options: { domain: string; threshold: number; since: Date }
): SignupBurstVerdict {
  const cohort = [
    ...new Map(
      signups
        .filter(signup => signup.domain === options.domain && signup.verifiedAt >= options.since)
        .map(signup => [signup.userId, signup])
    ).values(),
  ].sort((a, b) => a.verifiedAt.getTime() - b.verifiedAt.getTime() || a.userId.localeCompare(b.userId));
  const result = { suspicious: false, reason: '', signupCount: cohort.length };
  if (cohort.length < options.threshold) return result;

  const shortSubdomains = new Set(
    cohort
      .map(signup => {
        const host = emailDomainOf(signup.email) ?? '';
        const subdomain = host.endsWith(`.${options.domain}`) ? host.slice(0, -options.domain.length - 1) : '';
        return /^[a-z0-9]{2,3}$/.test(subdomain) ? subdomain : '';
      })
      .filter(Boolean)
  );
  const generated = cohort.map(signup => /^([a-z]+?)([0-9][a-f0-9]{3,11})$/i.exec(signup.email.split('@')[0] ?? ''));
  const suffixes = generated.filter(match => match !== null).map(match => Number.parseInt(match[2], 16));
  const monotonic =
    suffixes.length >= options.threshold &&
    suffixes.every((value, index) => index === 0 || value > suffixes[index - 1]);
  const prefixes = new Map<string, number>();
  for (const match of generated) {
    if (match) prefixes.set(match[1].toLowerCase(), (prefixes.get(match[1].toLowerCase()) ?? 0) + 1);
  }
  const sharedPrefix = [...prefixes.values()].some(count => count >= options.threshold);
  const patterned = monotonic || sharedPrefix;
  if (!patterned) return result;
  return {
    suspicious: true,
    signupCount: cohort.length,
    reason:
      shortSubdomains.size >= 3
        ? 'Verified signup burst with generated local parts and rotating short subdomains'
        : 'Verified signup burst with generated local parts',
  };
}
