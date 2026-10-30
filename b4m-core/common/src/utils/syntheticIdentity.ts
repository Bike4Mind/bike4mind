import { RESERVED_USERNAME_PREFIX } from '../schemas/username';

/**
 * Lower-cased domains from a comma/whitespace separated list. A leading `@` or `*.` and a trailing
 * dot are tolerated: every entry already covers its subdomains, so `*.test.example` is `test.example`.
 */
export function parseSyntheticDomainList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,]+/)
    .map(d => d.trim().toLowerCase().replace(/^@/, '').replace(/^\*\./, '').replace(/\.+$/, ''))
    .filter(Boolean);
}

/**
 * Whether an account is a test persona: the reserved username prefix, or an email on (or under) one
 * of the configured test domains (the `syntheticUserEmailDomains` admin setting). The username check
 * is the plain case-insensitive prefix; isReservedUsername is the broader rule that keeps ordinary
 * users from claiming it.
 */
export function isSyntheticIdentity(
  identity: { username?: string | null; email?: string | null },
  testDomains: readonly string[]
): boolean {
  if (identity.username?.toLowerCase().startsWith(RESERVED_USERNAME_PREFIX)) return true;
  const domain = identity.email?.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return testDomains.some(d => domain === d || domain.endsWith(`.${d}`));
}
