export interface LinkPolicyOptions {
  /** Hosts allowed for https links, normally summary.page.linkHosts. */
  linkHosts: readonly string[];
  /** The only address a mailto: link may point at. */
  supportEmail?: string | null;
}

export type LinkDecision =
  | { allowed: true; href: string; host: string }
  | {
      allowed: false;
      reason: 'invalid' | 'scheme' | 'credentials' | 'port' | 'host_not_allowed' | 'mailto_not_allowed';
    };

const MAX_HREF_LENGTH = 2048;

export function normalizeLinkHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function parseHttpsUrl(value: string): URL | null {
  if (value.length === 0 || value.length > MAX_HREF_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function isHttpsUrl(value: string): boolean {
  return parseHttpsUrl(value) !== null;
}

/** Sorted, de-duplicated hosts of the given https URLs; anything else is ignored. */
export function buildLinkHosts(urls: readonly (string | null | undefined)[]): string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    const url = parseHttpsUrl(value);
    if (url) hosts.add(normalizeLinkHost(url.hostname));
  }
  return [...hosts].sort();
}

export function isLinkHostAllowed(host: string, linkHosts: readonly string[]): boolean {
  const wanted = normalizeLinkHost(host);
  return wanted.length > 0 && linkHosts.some(allowed => normalizeLinkHost(allowed) === wanted);
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN_HREF_CHARS = /[\u0000- \u007f-\u009f\\<>"'`]/;

/** https links render as links only for allowlisted hosts; mailto only to the support address. */
export function classifyLink(rawHref: string, options: LinkPolicyOptions): LinkDecision {
  const href = rawHref.trim();
  if (href.length === 0 || href.length > MAX_HREF_LENGTH || FORBIDDEN_HREF_CHARS.test(href)) {
    return { allowed: false, reason: 'invalid' };
  }

  if (/^mailto:/i.test(href)) {
    const address = href.slice('mailto:'.length).toLowerCase();
    const support = options.supportEmail?.trim().toLowerCase();
    if (support && address === support) return { allowed: true, href: `mailto:${address}`, host: address };
    return { allowed: false, reason: 'mailto_not_allowed' };
  }

  if (!/^https:/i.test(href)) return { allowed: false, reason: 'scheme' };
  const url = parseHttpsUrl(href);
  if (!url) return { allowed: false, reason: 'invalid' };
  if (url.username !== '' || url.password !== '') return { allowed: false, reason: 'credentials' };
  if (url.port !== '') return { allowed: false, reason: 'port' };
  const host = normalizeLinkHost(url.hostname);
  if (!isLinkHostAllowed(host, options.linkHosts)) return { allowed: false, reason: 'host_not_allowed' };
  return { allowed: true, href: url.href, host };
}
