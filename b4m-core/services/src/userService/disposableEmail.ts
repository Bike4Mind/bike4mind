// `disposable-domains` (the UserCheck list) ships its list as index.json (its package `main`).
// The `with { type: 'json' }` attribute is required for two independent reasons:
//   1. Node 24 (which runs the CLI) rejects a bare ESM JSON import without it
//      (ERR_IMPORT_ATTRIBUTE_MISSING) - the CLI's rolldown bundle keeps this
//      import external, so the attribute must reach the emitted output.
//   2. It stays a *static* import, so the file tracer that builds the server
//      Lambda's closure (OpenNext, pinned in infra/web.ts) includes index.json.
//      A createRequire/readFileSync form is invisible to a static tracer and
//      drops the file, 500-ing registration on deploy (isDisposableEmail runs
//      by default).
import disposableDomains from 'disposable-domains' with { type: 'json' };
import {
  emailDomainCandidates,
  emailDomainOf,
  IAdminSettingsRepository,
  isEmailInDomains,
  parseInternalStaffDomains,
  partitionDomainList,
  settingsMap,
} from '@bike4mind/common';
import type { DisposableListSource, DisposableRefusalSource, SignupProtection } from '@bike4mind/common';

/**
 * Privacy alias forwarders: real users hide a real inbox behind them, so they are never treated as
 * disposable even though some upstream lists (tompec among them) carry them. Matched on parent
 * domains too, since some hand out per-user subdomains (x@alias.33mail.com). The refresh job in
 * apps/workers/src/cron/disposableDomainRefresh.ts drops these from every list it ingests.
 */
export const PRIVACY_RELAY_DOMAINS: ReadonlySet<string> = new Set([
  '33mail.com',
  'addy.io',
  'aleeas.com',
  'anonaddy.com',
  'anonaddy.me',
  'duck.com',
  'mozmail.com',
  'privaterelay.appleid.com',
  'simplelogin.co',
  'simplelogin.com',
  'simplelogin.fr',
  'slmail.me',
]);

/** True when the domain is a privacy relay or one of its subdomains. */
export const isPrivacyRelayDomain = (domain: string): boolean =>
  emailDomainCandidates(`x@${domain}`).some(candidate => PRIVACY_RELAY_DOMAINS.has(candidate));

// ~135k domain suffixes; the same list the refresh job pulls as the `tompec` source.
const DISPOSABLE_DOMAINS = new Set<string>(
  (disposableDomains as string[]).filter(domain => !isPrivacyRelayDomain(domain))
);

/**
 * True when the email's domain - or any parent domain - is a known disposable
 * provider. Parent-domain matching matters because services like Mailinator
 * accept mail on arbitrary subdomains (x@anything.mailinator.com), while the
 * list only carries the registrable domain.
 */
export const isDisposableEmail = (email: string): boolean => {
  const candidates = emailDomainCandidates(email);
  return (
    !candidates.some(domain => PRIVACY_RELAY_DOMAINS.has(domain)) &&
    candidates.some(domain => DISPOSABLE_DOMAINS.has(domain))
  );
};

/**
 * Refreshed lists precise enough to reject on: the human-curated list, fakefilter (observed on
 * live temp-mail services) and tompec (UserCheck, maintained weekly). The `aggregate` list also
 * scrapes, so a domain only there is held for review instead (see domainIntelligence.ts).
 */
export const REJECT_TIER_SOURCES: ReadonlySet<DisposableListSource> = new Set(['curated', 'fakefilter', 'tompec']);

export const blockedDomainsFrom = (settingValue: unknown): Set<string> => {
  const parsed = settingsMap.blockedEmailDomains.schema.safeParse(settingValue);
  return new Set(parsed.success ? partitionDomainList(parsed.data).valid : []);
};

const blockDisposableFrom = (settingValue: unknown): boolean => {
  const parsed = settingsMap.blockDisposableEmails.schema.safeParse(settingValue);
  return parsed.success ? parsed.data : true;
};

/**
 * True when the email is on (or under) a domain in the admin-edited blockedEmailDomains setting,
 * which covers fresh burner domains the static package has not caught up to.
 */
export const isAdminBlockedEmailDomain = async (
  email: string,
  { adminSettings }: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'> }
): Promise<boolean> => {
  const setting = await adminSettings.findBySettingName('blockedEmailDomains');
  return isEmailInDomains(email, blockedDomainsFrom(setting?.settingValue));
};

/**
 * The anti-sybil gate for credit-bearing signups: true when the email is on an admin-blocked
 * domain, or is disposable and the blockDisposableEmails setting (default ON) is enabled. Disposable
 * means the static package list or, when `signupProtection` carries the refreshed lists, a
 * reject-tier source (REJECT_TIER_SOURCES). A refreshed-list hit never rejects an organization or
 * internal staff domain, since those lists change daily without review. The admin list applies
 * regardless of that toggle, which exists to work around a false positive in the lists. A failed
 * list read throws, so callers fail closed. Shared by registerUser, the OAuth signup gate in
 * apps/client/server/utils/auth/verifyCallback.ts and the free-credit eligibility check in
 * apps/client/server/auth/emailVerifiedGrants.ts (email change and admin signup-domain holds) so they
 * cannot drift.
 */
export const shouldBlockDisposableEmail = async (
  email: string,
  deps: { adminSettings: IAdminSettingsRepository; signupProtection?: SignupProtection }
): Promise<boolean> => {
  const sources = await disposableRefusalSources(email, deps);
  if (!sources) return false;
  await recordRefusal(email, sources, deps.signupProtection);
  return true;
};

/** Why the email is refused (every matching source), or null when it is allowed. */
const disposableRefusalSources = async (
  email: string,
  { adminSettings, signupProtection }: { adminSettings: IAdminSettingsRepository; signupProtection?: SignupProtection }
): Promise<DisposableRefusalSource[] | null> => {
  if (await isAdminBlockedEmailDomain(email, { adminSettings })) return ['admin'];
  const listed = isDisposableEmail(email);
  const repository = signupProtection?.repository;
  if (!listed && !repository?.disposableSources) return null;
  // The toggle is read before the list query so switching it off also bypasses a failing list read.
  const setting = await adminSettings.findBySettingName('blockDisposableEmails');
  if (!blockDisposableFrom(setting?.settingValue)) return null;
  if (listed || !repository?.disposableSources) return listed ? ['static'] : null;
  const rejectTier = (await repository.disposableSources(emailDomainCandidates(email))).filter(source =>
    REJECT_TIER_SOURCES.has(source)
  );
  if (!rejectTier.length) return null;
  const staffDomains = new Set(parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS));
  if (isEmailInDomains(email, staffDomains) || (await repository.isOrganizationDomain(email))) return null;
  return rejectTier;
};

/** One log line per refusal, plus the app's metric hook, so a false positive is traceable to its list. */
const recordRefusal = async (
  email: string,
  sources: DisposableRefusalSource[],
  signupProtection: SignupProtection | undefined
): Promise<void> => {
  const domain = emailDomainOf(email) ?? '';
  console.log(JSON.stringify({ event: 'disposable-email-refused', domain, sources }));
  try {
    await signupProtection?.recordDisposableRefusal?.({ domain, sources });
  } catch (error) {
    console.warn('Disposable refusal record failed', { domain, error: String(error) });
  }
};

/**
 * shouldBlockDisposableEmail as a sync predicate over settings read once, for callers that check
 * many emails in a loop (packages/scripts/backfillOAuthStartingGrant.ts). Static and admin lists
 * only: it does not see the refreshed reject-tier lists.
 */
export const createSignupEmailGate = async (
  adminSettings: IAdminSettingsRepository
): Promise<(email: string) => boolean> => {
  const settings = await adminSettings.findBySettingNames(['blockedEmailDomains', 'blockDisposableEmails']);
  const valueOf = (name: string) => settings.find(s => s.settingName === name)?.settingValue;
  const blockedDomains = blockedDomainsFrom(valueOf('blockedEmailDomains'));
  const blockDisposable = blockDisposableFrom(valueOf('blockDisposableEmails'));
  return email => isEmailInDomains(email, blockedDomains) || (blockDisposable && isDisposableEmail(email));
};
