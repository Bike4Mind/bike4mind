/**
 * SSRF (Server-Side Request Forgery) protection for apps/client API routes.
 *
 * The private-IP / hostname classifier lives ONCE in @bike4mind/fab-pipeline
 * (b4m-core/fab-pipeline/src/ssrfProtection.ts): a single hardened IPv6 classifier so the range
 * logic cannot fork and drift apart (the #1969 regression). This module re-exports that classifier
 * and adds only the fetch-call-site pieces fab-pipeline's node-http/https agents cannot provide for
 * the global fetch() these routes use: an https-only assert and a redirect-revalidating safeFetch.
 */

import { validateUrlForFetch } from '@bike4mind/fab-pipeline';

// Re-exported so existing importers (webhook delivery, external-image cache, route tests) keep their
// path while the implementation stays single-sourced in fab-pipeline. validateTargetUrl is
// fab-pipeline's validateUrlForFetch under the name this codebase already calls it (http+https,
// DNS-resolving: blocks private/internal hostnames and any host that resolves to a private IP).
export {
  isPrivateIP,
  isPrivateOrInternalHostname,
  validateUrlForFetch as validateTargetUrl,
} from '@bike4mind/fab-pipeline';

/**
 * Returns an `isAllowedHost(url)` predicate scoped to the given allowlist.
 * Matching is exact or subdomain: `makeAllowedHostChecker(['linkedin.com'])` allows
 * `api.linkedin.com` but not `lnkd.in` or `linkedin.com.evil.com`.
 *
 * @param allowedHosts - Exact hostnames or apex domains whose subdomains are also allowed
 */
export function makeAllowedHostChecker(allowedHosts: string[]): (url: string) => boolean {
  return (url: string) => {
    try {
      const { hostname } = new URL(url);
      return allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  };
}

/** Thrown by {@link safeFetch} when a target, or its redirect target, is unsafe to fetch. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Assert a caller/user-influenced URL is safe to fetch server-side, or throw SsrfError.
 * https-only, then defers to fab-pipeline's validateUrlForFetch, which blocks private/internal
 * hostnames AND resolves DNS and rejects if any resolved IP is private - so a public NAME that
 * resolves to a private address (e.g. 127.0.0.1.nip.io) is caught, not just literal IPs. DNS
 * resolution is I/O, hence async. For fetch call sites use {@link safeFetch}, which also re-checks a
 * redirect hop.
 *
 * @throws SsrfError with a human-readable reason if the URL is not allowed.
 */
export async function assertUrlAllowed(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError('not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfError('only https URLs are allowed');
  }
  const { valid, error } = await validateUrlForFetch(url);
  if (!valid) {
    throw new SsrfError(error ?? 'points to a private or internal network');
  }
}

/**
 * Fetch a caller/user-influenced URL with SSRF protection on BOTH the initial host and a single
 * redirect hop. A plain fetch defaults to redirect:'follow', so a guard on the initial URL alone is
 * bypassed by a public host that 3xx-redirects to an internal one. This validates up front
 * (assertUrlAllowed, DNS-resolving), fetches with redirect:'manual', re-validates the Location the
 * same way, and follows at most one hop with redirect:'error'. Callers keep their own
 * timeout/size/content-type handling via `init` and the returned Response.
 *
 * TOCTOU residual: validateUrlForFetch resolves DNS here, but global fetch() (undici) resolves the
 * name again at connect time and cannot install fab-pipeline's connect-time ssrfSafeLookup, which is
 * built for the node-http/axios agents. So for a user-supplied host whose authoritative DNS an
 * attacker controls, this leaves a blind connect oracle rather than an internal read - and what keeps
 * it a blind oracle is that every safeFetch caller bounds the bytes an upstream response can return:
 * blog/publish.ts, blog/presign-image-upload.ts, blog-integration/index.ts, and external-image.ts
 * (the riskiest - an open admin-supplied URL streamed up to a 10MB cap). Same residual the repo
 * already accepts for its other fetch()-based SSRF guards.
 *
 * @throws SsrfError if the target or its redirect target is unsafe.
 */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await assertUrlAllowed(url);

  const response = await fetch(url, { ...init, redirect: 'manual' });
  const isRedirect = response.status >= 300 && response.status < 400;
  if (!isRedirect) {
    return response;
  }

  const location = response.headers.get('location');
  if (!location) {
    throw new SsrfError('redirect without a Location header');
  }
  const target = new URL(location, url).toString();
  try {
    await assertUrlAllowed(target);
  } catch (e) {
    if (e instanceof SsrfError) {
      throw new SsrfError(`blocked redirect: ${e.message}`);
    }
    throw e;
  }
  // One extra hop only: redirect:'error' rejects any further redirect from the target.
  return fetch(target, { ...init, redirect: 'error' });
}
