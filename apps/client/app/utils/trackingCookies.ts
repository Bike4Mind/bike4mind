const EXPIRED = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
const FIXED_NAMES = ['_fbp', '_fbc', '_rdt_uuid', '_rdt_em', '_rdt_cid', '_ga', '_gcl_au'];

/** Two-label suffixes shared between unrelated sites; browsers ignore cookies set on them. */
const SHARED_SUFFIXES = new Set(['cloudfront.net', 'vercel.app', 'amazonaws.com', 'netlify.app', 'herokuapp.com']);

/** Candidate Domain= values: the host itself and each parent down to two labels, since the
 * pixels pin their cookies to the apex and a cookie only expires under the domain that set it. */
export function cookieDomains(hostname: string): string[] {
  if (!hostname || hostname === 'localhost' || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return [];
  const labels = hostname.split('.');
  const domains: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    const domain = labels.slice(i).join('.');
    if (i > 0 && SHARED_SUFFIXES.has(domain)) break;
    domains.push(domain);
  }
  return domains;
}

/** Expires the ad and analytics cookies the pixels set (Meta, Reddit, GA incl. `_ga_*`),
 * on the current host and its parent domains. Intentionally includes the apex copies the
 * marketing site shares: a decline here withdraws consent for the browser, not one subdomain.
 * It does not write the marketing site's decision cookie, so that site may set them again. */
export function clearTrackingCookies(): void {
  if (typeof document === 'undefined') return;
  const names = new Set(FIXED_NAMES);
  for (const entry of document.cookie.split('; ')) {
    const name = entry.split('=')[0];
    if (name.startsWith('_ga_')) names.add(name);
  }
  const domains = cookieDomains(window.location.hostname);
  for (const name of names) {
    document.cookie = `${name}=; path=/; ${EXPIRED}`;
    for (const domain of domains) {
      document.cookie = `${name}=; path=/; domain=${domain}; ${EXPIRED}`;
      document.cookie = `${name}=; path=/; domain=.${domain}; ${EXPIRED}`;
    }
  }
}
