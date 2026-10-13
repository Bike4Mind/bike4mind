const EXPIRED = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
const FIXED_NAMES = ['_fbp', '_rdt_uuid', '_rdt_em', '_ga'];

/** Candidate Domain= values: the host itself and each parent down to two labels, since the
 * pixels pin their cookies to the apex and a cookie only expires under the domain that set it. */
function cookieDomains(hostname: string): string[] {
  if (!hostname || hostname === 'localhost' || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return [];
  const labels = hostname.split('.');
  const domains: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) domains.push(labels.slice(i).join('.'));
  return domains;
}

/** Expires the ad and analytics cookies the pixels set (Meta, Reddit, GA incl. `_ga_*`),
 * on the current host and its parent domains. */
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
