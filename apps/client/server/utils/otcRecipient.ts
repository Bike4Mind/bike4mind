import { adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { emailDomainOf, personalEmailProviders } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { signupProtection } from '@server/auth/signupProtection';
import { otcEmailKey } from './otcLimits';

const HOUR_MS = 60 * 60 * 1000;
const MAIL_DNS_TIMEOUT_MS = 2_000;
const ACCEPTS_MAIL_CACHE_MS = 24 * HOUR_MS;
const REJECTS_MAIL_CACHE_MS = HOUR_MS;
const PERSONAL_EMAIL_PROVIDERS: ReadonlySet<string> = new Set(personalEmailProviders);

export type OtcRecipientRefusal = 'blocked-domain' | 'no-mail-host';

/** Cached per domain; an undecided lookup is not cached and counts as deliverable. */
async function domainAcceptsMail(domain: string): Promise<boolean> {
  const key = `otc-mail-domain:${otcEmailKey(domain)}`;
  const cached = await cacheRepository.findByKey(key);
  if (typeof cached?.result === 'boolean') return cached.result;

  const accepts = await userService.domainAcceptsMail(domain, { timeoutMs: MAIL_DNS_TIMEOUT_MS });
  if (accepts === undefined) return true;
  const ttlMs = accepts ? ACCEPTS_MAIL_CACHE_MS : REJECTS_MAIL_CACHE_MS;
  await cacheRepository.createOrUpdate({ key, result: accepts, expiresAt: new Date(Date.now() + ttlMs) });
  return accepts;
}

/**
 * Why a sign-in code should not be mailed to `email`, judged on its domain alone: the signup
 * disposable/blocked-domain gate, or a domain that cannot receive mail. Fails open on any error.
 */
export async function otcRecipientRefusal(email: string, logger: Logger): Promise<OtcRecipientRefusal | undefined> {
  try {
    const adapters = { adminSettings: adminSettingsRepository, signupProtection };
    if (await userService.shouldBlockDisposableEmail(email, adapters)) return 'blocked-domain';
    const domain = emailDomainOf(email);
    if (!domain || PERSONAL_EMAIL_PROVIDERS.has(registrableDomain(domain) ?? '')) return undefined;
    return (await domainAcceptsMail(domain)) ? undefined : 'no-mail-host';
  } catch (error) {
    logger.warn('otc-recipient-check-failed', error);
    return undefined;
  }
}
