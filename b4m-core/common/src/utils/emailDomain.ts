// A hostname with at least two labels: letters, digits and inner hyphens, no empty labels.
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonical form of an admin-entered domain: lowercased and trimmed, with a leading `@` or `*.`
 * and a trailing dot (FQDN form) removed, so `@Kashre.com`, `*.kashre.com` and `kashre.com.` all
 * become `kashre.com`. Returns null when what is left is not a hostname.
 */
export function normalizeEmailDomain(raw: string): string | null {
  const domain = trimDomain(raw.trim().replace(/^@/, '').replace(/^\*\./, ''));
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

// Ideographic and fullwidth full stops, which some mail stacks treat as a plain dot.
const UNICODE_DOTS = /[\u3002\uff0e\uff61]/g;

function trimDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(UNICODE_DOTS, '.').replace(/\.+$/, '');
}

/**
 * The domain part of an email (after the last `@`), lowercased, trimmed, with Unicode full stops
 * read as dots and trailing dots removed; null when there is none. Deliberately not
 * hostname-validated: a blocklist check must still see an odd-looking domain rather than skip it.
 */
export function emailDomainOf(email: string): string | null {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return null;
  return trimDomain(email.slice(atIndex + 1)) || null;
}

/**
 * The email's domain followed by each parent domain, most specific first:
 * `x@np.kashre.com` -> `['np.kashre.com', 'kashre.com']`. A list that stores registrable domains
 * matches a burner service's random subdomains by checking every candidate.
 */
export function emailDomainCandidates(email: string): string[] {
  const domain = emailDomainOf(email);
  return domain ? domainCandidates(domain) : [];
}

/** The domain followed by each parent domain, most specific first: `np.kashre.com` -> `['np.kashre.com', 'kashre.com']`. */
function domainCandidates(domain: string): string[] {
  const candidates: string[] = [];
  for (let candidate = domain; candidate.includes('.'); candidate = candidate.slice(candidate.indexOf('.') + 1)) {
    candidates.push(candidate);
  }
  return candidates;
}

/** True when the email is on one of the domains or on any subdomain of one. */
export function isEmailInDomains(email: string, domains: ReadonlySet<string>): boolean {
  return emailDomainCandidates(email).some(candidate => domains.has(candidate));
}

/** True when the domain is one of the domains or a subdomain of one. */
export function isDomainInDomains(domain: string, domains: ReadonlySet<string>): boolean {
  return domainCandidates(domain).some(candidate => domains.has(candidate));
}

/**
 * Splits a stored list of domains into usable (normalized, deduped) and invalid entries. Checked
 * one entry at a time so a single typo cannot discard the whole list. Non-array input yields
 * nothing; non-string entries count as invalid. Mirrors partitionEmailList (./emailList).
 */
export function partitionDomainList(entries: unknown): { valid: string[]; invalid: string[] } {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const domain = typeof entry === 'string' ? normalizeEmailDomain(entry) : null;
    if (domain) valid.add(domain);
    else invalid.push(String(entry));
  }
  return { valid: [...valid], invalid };
}
