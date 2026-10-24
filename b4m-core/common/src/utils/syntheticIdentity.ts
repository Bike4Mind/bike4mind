/** Usernames starting with this mark test-persona accounts. */
export const SYNTHETIC_USERNAME_PREFIX = 'persona-';

/** Lower-cased domains from a comma/whitespace separated list; leading `@` tolerated. */
export function parseSyntheticDomainList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,]+/)
    .map(d => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * Whether an account is a test persona: the username prefix, or an email on (or under) one of the
 * configured test domains (the `syntheticUserEmailDomains` admin setting).
 */
export function isSyntheticIdentity(
  identity: { username?: string | null; email?: string | null },
  testDomains: readonly string[]
): boolean {
  if (identity.username?.toLowerCase().startsWith(SYNTHETIC_USERNAME_PREFIX)) return true;
  const domain = identity.email?.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return testDomains.some(d => domain === d || domain.endsWith(`.${d}`));
}
