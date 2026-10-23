// `disposable-email-domains` ships its list as index.json (its package `main`).
// The `with { type: 'json' }` attribute is required for two independent reasons:
//   1. Node 24 (which runs the CLI) rejects a bare ESM JSON import without it
//      (ERR_IMPORT_ATTRIBUTE_MISSING) - the CLI's rolldown bundle keeps this
//      import external, so the attribute must reach the emitted output.
//   2. It stays a *static* import, so the file tracer that builds the server
//      Lambda's closure (OpenNext, pinned in infra/web.ts) includes index.json.
//      A createRequire/readFileSync form is invisible to a static tracer and
//      drops the file, 500-ing registration on deploy (isDisposableEmail runs
//      by default).
import disposableDomains from 'disposable-email-domains' with { type: 'json' };
import {
  emailDomainCandidates,
  IAdminSettingsRepository,
  isEmailInDomains,
  partitionDomainList,
  settingsMap,
} from '@bike4mind/common';

// ~4.5k entries from the maintained `disposable-email-domains` list.
const DISPOSABLE_DOMAINS = new Set<string>(disposableDomains as string[]);

/**
 * True when the email's domain - or any parent domain - is a known disposable
 * provider. Parent-domain matching matters because services like Mailinator
 * accept mail on arbitrary subdomains (x@anything.mailinator.com), while the
 * list only carries the registrable domain.
 */
export const isDisposableEmail = (email: string): boolean =>
  emailDomainCandidates(email).some(domain => DISPOSABLE_DOMAINS.has(domain));

/**
 * True when the email is on (or under) a domain in the admin-edited blockedEmailDomains setting,
 * which covers fresh burner domains the static package has not caught up to.
 */
export const isAdminBlockedEmailDomain = async (
  email: string,
  { adminSettings }: { adminSettings: IAdminSettingsRepository }
): Promise<boolean> => {
  const setting = await adminSettings.findBySettingName('blockedEmailDomains');
  const parsed = settingsMap.blockedEmailDomains.schema.safeParse(setting?.settingValue);
  if (!parsed.success) return false;
  return isEmailInDomains(email, new Set(partitionDomainList(parsed.data).valid));
};

/**
 * The anti-sybil gate for credit-bearing signups: true when the email is on an admin-blocked
 * domain, or is disposable and the blockDisposableEmails setting (default ON) is enabled. The
 * admin list applies regardless of that toggle, which exists to work around a false positive in
 * the package list. Shared by registerUser and the free-credit eligibility check in
 * apps/client/server/auth/emailVerifiedGrants.ts (OAuth signup, email change) so they cannot drift.
 */
export const shouldBlockDisposableEmail = async (
  email: string,
  { adminSettings }: { adminSettings: IAdminSettingsRepository }
): Promise<boolean> => {
  if (await isAdminBlockedEmailDomain(email, { adminSettings })) return true;
  if (!isDisposableEmail(email)) return false;
  const setting = await adminSettings.findBySettingName('blockDisposableEmails');
  const parsed = settingsMap.blockDisposableEmails.schema.safeParse(setting?.settingValue);
  return parsed.success ? parsed.data : true;
};
