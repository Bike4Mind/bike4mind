/**
 * Helpers shared across attack simulation probes.
 *
 * All probes target the deployment's own URL - never an external host. The domain guard
 * below is enforced at the runner level and re-enforced here as defense-in-depth.
 */

// Exact host matches for production and staging - derived from the deployment's own
// SERVER_DOMAIN with NO brand fallback, so a fork never probes another
// deployment's hosts. Wildcards are intentionally avoided here because `*.<domain>` would
// otherwise allow marketing/blog/partner subdomains unrelated to the app surface. When
// SERVER_DOMAIN is unset the allowlist is empty and probing fails closed.
const SERVER_DOMAIN = process.env.SERVER_DOMAIN || '';
const ALLOWED_EXACT_HOSTS = SERVER_DOMAIN ? [`app.${SERVER_DOMAIN}`, `app.staging.${SERVER_DOMAIN}`] : [];

// PR preview environments are dynamic; constrain the pattern so an arbitrary
// `*.preview.<domain>` host (e.g. a misconfigured marketing preview) cannot be probed.
// Format: `app.pr<digits>.preview.<SERVER_DOMAIN>` - exactly what SST generates per PR.
// Empty (never-matching) when SERVER_DOMAIN is unset so preview matching fails closed.
const ALLOWED_PREVIEW_HOST_PATTERN = SERVER_DOMAIN
  ? new RegExp(`^app\\.pr\\d+\\.preview\\.${SERVER_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  : /(?!)/;

export function assertTargetUrlIsSafe(targetUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error(`Invalid target URL: ${targetUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Target URL must use HTTPS: ${targetUrl}`);
  }
  const host = parsed.host.toLowerCase();
  const isExact = ALLOWED_EXACT_HOSTS.includes(host);
  const isPreview = ALLOWED_PREVIEW_HOST_PATTERN.test(host);
  if (!isExact && !isPreview) {
    throw new Error(`Target URL host not allowed: ${host}`);
  }
  return parsed;
}

export interface ProbeResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  wafBlocked: boolean;
}

/**
 * Detects whether a response was blocked by AWS WAF rather than the application.
 *
 * Strong signals (always treated as WAF block):
 *   - `x-amzn-waf-action` / `x-amz-waf-action` header present
 *   - `x-cache: Error from cloudfront` - the canonical signal for a CloudFront-served error
 *     page (typically WAF or origin-unreachable)
 *
 * Weak signal (kept for legacy/edge cases):
 *   - `Server: CloudFront` + 403 + no `x-cache` of any kind
 *
 * The weak heuristic can false-positive on legit app 403s served via CloudFront; we keep it
 * because erring toward "WAF interfered" produces a low-severity P3 finding rather than a
 * silent passing test, which is the right side to err on for an attack-simulation system.
 */
function detectWafBlocked(headers: Record<string, string>, status: number): boolean {
  if (status !== 403) return false;
  const wafActionHeader = headers['x-amzn-waf-action'] || headers['x-amz-waf-action'];
  if (wafActionHeader) return true;

  const xCache = headers['x-cache'] || '';
  if (xCache.toLowerCase().includes('error from cloudfront')) return true;

  const server = (headers['server'] || '').toLowerCase();
  if (server.includes('cloudfront') && !xCache) {
    return true;
  }
  return false;
}

export async function probeFetch(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const bodyText = await response.text().catch(() => '');
    return {
      status: response.status,
      headers,
      bodyText,
      wafBlocked: detectWafBlocked(headers, response.status),
    };
  } finally {
    clearTimeout(timer);
  }
}
