/**
 * SSRF (Server-Side Request Forgery) Protection Utilities
 *
 * Provides validation functions to prevent SSRF attacks by blocking
 * requests to internal/private networks, cloud metadata endpoints,
 * and other sensitive destinations.
 *
 * Used by webhook delivery, blog integration, and external-image fetching.
 *
 * `isPrivateIP` and `isPrivateOrInternalHostname` are re-exported from `@bike4mind/fab-pipeline`
 * rather than reimplemented here - this file used to carry its own per-hextet IPv6 prefix list that
 * drifted out of sync with the hardened one there (#1969). The fetch-call-site helpers below
 * (assertUrlAllowed, safeFetch, fetchPinned) add an https-only assert, a redirect-revalidating fetch,
 * and a shared fetch client from fab-pipeline's createPinnedFetch.
 */

import { isPrivateIP, isPrivateOrInternalHostname } from '@bike4mind/fab-pipeline';
import { PinnedFetchError, createPinnedFetch, type PinnedFetch } from '@bike4mind/fab-pipeline/ssrf';
import dns from 'dns';
import { promisify } from 'util';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

export { isPrivateIP, isPrivateOrInternalHostname };

/**
 * Validate a URL for webhook delivery.
 * Blocks internal/private networks to prevent SSRF attacks.
 * Resolves DNS and validates resolved IPs. This lookup is separate from the one a later fetch makes;
 * use {@link fetchPinned} or {@link safeFetch} so the connection uses an address that passed validation.
 *
 * @param url - The URL to validate
 * @returns Object with valid flag and optional error message
 */
export async function validateTargetUrl(url: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const parsed = new URL(url);

    // Must be HTTP or HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
    }

    // First check hostname directly (catches localhost, explicit IPs, etc.)
    if (isPrivateOrInternalHostname(parsed.hostname)) {
      return { valid: false, error: 'URL points to a private or internal network' };
    }

    // For non-IP hostnames, resolve DNS and validate all resolved IPs
    // so a public name that resolves to a private IP is refused
    const isIPv4Address = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname);
    const isIPv6Address = parsed.hostname.includes(':');

    if (!isIPv4Address && !isIPv6Address) {
      try {
        // Try to resolve IPv4 addresses
        const ipv4Addresses = await dnsResolve4(parsed.hostname).catch(() => [] as string[]);

        // Try to resolve IPv6 addresses
        const ipv6Addresses = await dnsResolve6(parsed.hostname).catch(() => [] as string[]);

        const allAddresses = [...ipv4Addresses, ...ipv6Addresses];

        if (allAddresses.length === 0) {
          return { valid: false, error: 'Could not resolve hostname' };
        }

        // Check ALL resolved IPs - block if ANY is private
        for (const ip of allAddresses) {
          if (isPrivateIP(ip)) {
            return { valid: false, error: `Hostname resolves to private IP address (${ip})` };
          }
        }
      } catch {
        return { valid: false, error: 'Could not resolve hostname' };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

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

/**
 * Synchronous URL validation for cases where DNS resolution is not needed
 * (e.g., the URL has already been validated or is known to be safe).
 *
 * @param url - The URL to validate
 * @returns Object with valid flag and optional error message
 */
export function validateTargetUrlSync(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Must be HTTP or HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use HTTP or HTTPS protocol' };
    }

    // Check hostname directly
    if (isPrivateOrInternalHostname(parsed.hostname)) {
      return { valid: false, error: 'URL points to a private or internal network' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/** Thrown by {@link safeFetch} and {@link fetchPinned} when a target, or a redirect target, is unsafe to fetch. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Assert a caller/user-influenced URL is safe to fetch server-side, or throw SsrfError.
 * https-only, then defers to validateTargetUrl, which blocks private/internal hostnames AND resolves
 * DNS and rejects if any resolved IP is private - so a public NAME that resolves to a private address
 * (e.g. 127.0.0.1.nip.io) is caught, not just literal IPs. DNS resolution is I/O, hence async. For
 * fetch call sites use {@link safeFetch}, which also re-checks a redirect hop.
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
  const { valid, error } = await validateTargetUrl(url);
  if (!valid) {
    throw new SsrfError(error ?? 'points to a private or internal network');
  }
}

export interface FetchPinnedOptions {
  /** Permit plain http (webhook targets may use it). Default false. */
  allowHttp?: boolean;
  /** Cap on decoded response body bytes. Default 2 MiB (createPinnedFetch's default). */
  maxBodyBytes?: number;
  /**
   * For callers that read only the status: no body cap, so a large reply cannot fail the request. The
   * caller must cancel `response.body` to release the connection. Overrides `maxBodyBytes`.
   */
  discardBody?: boolean;
}

const pinnedClients = new Map<string, PinnedFetch>();

function getPinnedClient({ allowHttp = false, maxBodyBytes, discardBody = false }: FetchPinnedOptions): PinnedFetch {
  const cap = discardBody ? Infinity : maxBodyBytes;
  const key = `${allowHttp}:${cap ?? 'default'}`;
  let client = pinnedClients.get(key);
  if (!client) {
    client = createPinnedFetch({ allowHttp, maxBodyBytes: cap });
    pinnedClients.set(key, client);
  }
  return client;
}

/** True when a response body exceeded the `maxBodyBytes` cap of {@link fetchPinned}. */
export function isResponseTooLargeError(error: unknown): boolean {
  return error instanceof PinnedFetchError && error.code === 'size_cap';
}

/**
 * fetch() for a URL that already passed {@link validateTargetUrl} or {@link assertUrlAllowed}. Each
 * connection re-checks the address it dials, so the connection uses an address that passed validation.
 * Redirects follow the caller's `redirect` mode and are revalidated per hop.
 *
 * @throws SsrfError when the target or a redirect hop resolves to a blocked address or scheme.
 */
export async function fetchPinned(
  url: string,
  init: RequestInit = {},
  options: FetchPinnedOptions = {}
): Promise<Response> {
  try {
    return await getPinnedClient(options)(url, init);
  } catch (error) {
    if (error instanceof PinnedFetchError && (error.code === 'ssrf_blocked' || error.code === 'scheme_blocked')) {
      throw new SsrfError(error.message);
    }
    throw error;
  }
}

/**
 * Fetch a caller/user-influenced URL with SSRF protection on BOTH the initial host and a single
 * redirect hop. A plain fetch defaults to redirect:'follow', so a guard on the initial URL alone is
 * bypassed by a public host that 3xx-redirects to an internal one. This validates up front
 * (assertUrlAllowed, DNS-resolving), fetches with redirect:'manual', re-validates the Location the
 * same way, and follows at most one hop with redirect:'error'. Callers keep their own
 * timeout/content-type handling via `init` and the returned Response. Callers may reject a
 * redirect target before the second fetch when their own routing rules make it unsafe.
 *
 * Both hops go through {@link fetchPinned}, so the connection uses the address that passed validation.
 * The response body is capped at `maxBodyBytes` (2 MiB by default); see {@link isResponseTooLargeError}.
 *
 * @throws SsrfError if the target or its redirect target is unsafe.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: { assertRedirectAllowed?: (target: URL) => void; maxBodyBytes?: number } = {}
): Promise<Response> {
  await assertUrlAllowed(url);
  const pinnedOptions = { maxBodyBytes: options.maxBodyBytes };

  const response = await fetchPinned(url, { ...init, redirect: 'manual' }, pinnedOptions);
  const isRedirect = response.status >= 300 && response.status < 400;
  if (!isRedirect) {
    return response;
  }

  const location = response.headers.get('location');
  await response.body?.cancel().catch(() => undefined);
  if (!location) {
    throw new SsrfError('redirect without a Location header');
  }
  const target = new URL(location, url).toString();
  try {
    options.assertRedirectAllowed?.(new URL(target));
    await assertUrlAllowed(target);
    // One extra hop only: redirect:'error' rejects any further redirect from the target.
    return await fetchPinned(target, { ...init, redirect: 'error' }, pinnedOptions);
  } catch (e) {
    if (e instanceof SsrfError) {
      throw new SsrfError(`blocked redirect: ${e.message}`);
    }
    throw e;
  }
}
