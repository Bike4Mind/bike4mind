/**
 * Young-domain recheck for the Signup Domain Holds queue, run by signupDomainHoldTriage.ts. A
 * `young-domain` hold is created once and never re-evaluated at signup (an existing review row
 * short-circuits signupProtection.ts), so without this it waits on an admin even after the domain
 * has aged. This records the domain's registration date and stamps `domainAgedAt` once it is at
 * least holdSignupsFromDomainsYoungerThanDays old.
 *
 * It never decides a hold: a release exempts the domain for good and cannot be re-blocked, so the
 * stamp is only a hint that lets an admin release with one click (SignupDomainHoldsTab.tsx).
 */
import type { DomainIntel } from '@bike4mind/common';
import { signupDomainReviewRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/** Holds looked up per run; the rest are picked up by the following runs. */
export const AGE_RECHECK_BATCH_LIMIT = 50;
/** A lookup that returned no registration date is retried no sooner than this (ms). */
export const AGE_RECHECK_RETRY_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SignupDomainAgeRecheckDeps = {
  holds: Pick<typeof signupDomainReviewRepository, 'listForAgeRecheck' | 'recordDomainAgeCheck' | 'markAgedDomains'>;
  youngerThanDays: () => Promise<number>;
  /** Cached RDAP facts for the domain; null when intel is unavailable. */
  domainIntel: (domain: string) => Promise<Pick<DomainIntel, 'registeredAt'> | null>;
  shouldStop: () => boolean;
  now: () => Date;
  logger: Pick<Logger, 'info' | 'error'>;
};

export type SignupDomainAgeRecheckResult = { looked: number; failed: number; marked: number };

export async function runSignupDomainAgeRecheck(
  deps: SignupDomainAgeRecheckDeps
): Promise<SignupDomainAgeRecheckResult> {
  const now = deps.now();
  const candidates = await deps.holds.listForAgeRecheck(
    new Date(now.getTime() - AGE_RECHECK_RETRY_MS),
    AGE_RECHECK_BATCH_LIMIT
  );
  let looked = 0;
  let failed = 0;
  for (const hold of candidates) {
    if (deps.shouldStop()) break;
    try {
      const intel = await deps.domainIntel(hold.domain);
      const registeredAt = intel?.registeredAt ? new Date(intel.registeredAt) : undefined;
      await deps.holds.recordDomainAgeCheck(hold.domain, now, registeredAt);
      looked++;
    } catch (error) {
      failed++;
      deps.logger.error('[signupDomainAgeRecheck] lookup failed', { domain: hold.domain, error });
    }
  }
  // 0 turns the age check off, so under the current policy any known registration date is aged.
  const days = await deps.youngerThanDays();
  const marked = await deps.holds.markAgedDomains(new Date(now.getTime() - days * DAY_MS), now);
  const result = { looked, failed, marked };
  if (candidates.length || marked) deps.logger.info('[signupDomainAgeRecheck] done', result);
  return result;
}
