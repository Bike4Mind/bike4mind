import { isPrivateIP } from '@bike4mind/fab-pipeline';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for direct server-side fetches this service makes against user/model-supplied origins.
 *
 * The main web_fetch path is SSRF-immune by construction when Firecrawl does the fetching on its own
 * infra. Two paths dial an origin directly and must reject private/loopback/link-local/cloud-
 * metadata targets: the llms.txt probe (`probeLlmsTxt`, response body never read) and the keyless
 * `plainFetchScrape` fallback, which DOES return page content. Callers must also use
 * `redirect: 'error'` so a public origin cannot 302-pivot to an internal address after the check.
 *
 * Because plainFetchScrape returns content, the lookup->connect DNS-rebind race matters there: it
 * uses `resolveAndVetUrl` and pins the vetted IP for http (see plainFetch.ts), which removes the
 * race for http. The `unsafeFetchUrlReason` boolean form (llms.txt probe) keeps the repo's accepted
 * best-effort posture (external-image.ts) since its body is never read.
 *
 * Private-address classification is delegated to `isPrivateIP` from `@bike4mind/fab-pipeline` -
 * this file used to reimplement the same per-hextet IPv6 prefix list and drifted out of sync with
 * it (#1969).
 */

/** Literal-hostname check (no DNS). Returns a reason string when unsafe, else null. */
export function unsafeHostnameReason(hostname: string): string | null {
  const raw = hostname.toLowerCase();
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') {
    return 'loopback host';
  }
  if (host.startsWith('::ffff:')) {
    return 'ipv4-mapped ipv6 address';
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && isPrivateIP(host)) {
    return 'private/reserved ipv4 address';
  }
  if (host.includes(':') && isPrivateIP(host)) {
    return 'private/reserved ipv6 address';
  }
  return null;
}

export type VettedFetchTarget = { safe: true; address: string; family: number } | { safe: false; reason: string };

/**
 * Full guard (protocol + literal hostname + resolved-address check) that also RETURNS the vetted
 * resolved address, so a content-returning caller can pin it (connect to that exact IP) rather than
 * letting fetch re-resolve and hit a rebind target. `unsafeFetchUrlReason` is the boolean form.
 */
export async function resolveAndVetUrl(url: URL): Promise<VettedFetchTarget> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: 'unsupported protocol' };
  }
  const literal = unsafeHostnameReason(url.hostname);
  if (literal) return { safe: false, reason: literal };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { safe: false, reason: 'dns resolution failed' };
  }
  for (const { address } of addresses) {
    if (isPrivateIP(address)) return { safe: false, reason: 'resolves to a private/reserved address' };
  }
  const first = addresses[0];
  if (!first) return { safe: false, reason: 'dns resolution failed' };
  return { safe: true, address: first.address, family: first.family };
}

/**
 * Full guard: protocol + literal hostname + resolved-address check. Returns a reason string when
 * the URL is unsafe to fetch server-side, or null when it is safe.
 */
export async function unsafeFetchUrlReason(url: URL): Promise<string | null> {
  const result = await resolveAndVetUrl(url);
  return result.safe ? null : result.reason;
}
