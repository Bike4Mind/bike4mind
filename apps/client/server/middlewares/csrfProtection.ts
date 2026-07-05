import { RequestHandler } from 'express';
import { ForbiddenError } from '@server/utils/errors';

/**
 * CSRF Protection Middleware
 *
 * Validates Origin and Referer headers to prevent Cross-Site Request Forgery attacks.
 * This is a simple but effective approach for same-site requests.
 *
 * For more complex scenarios, consider using the 'csurf' package with tokens.
 */
export const csrfProtection = (): RequestHandler => {
  return (req, res, next) => {
    // Skip CSRF check for GET, HEAD, OPTIONS requests (safe methods)
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // API key requests use a bearer token that a cross-site attacker cannot
    // read or forge, so they are not vulnerable to CSRF. Applying origin checks
    // to API key requests breaks all server-to-server integrations.
    if (req.headers['x-api-key']) {
      return next();
    }

    // `Sec-Fetch-Site` is set by every current-gen browser and cannot be
    // spoofed from JS. Rejecting non-`same-origin` is a cheap pre-check
    // that catches most cross-site submits even if Origin/Referer parsing
    // below has a gap. Missing header -> fall through to origin check for
    // older clients (curl, legacy browsers).
    const secFetchSite = req.headers['sec-fetch-site'];
    if (typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      throw new ForbiddenError(`Cross-site request rejected (sec-fetch-site=${secFetchSite}).`);
    }

    // `Sec-Fetch-Mode: no-cors` is the classic CSRF vector - it's how tags
    // like <img>, <script>, <link>, <video> trigger cross-origin requests
    // without a preflight. A state-changing API only ever legitimately sees
    // `cors`, `same-origin`, or `navigate` (form POST). Missing header ->
    // skip (server-to-server, older clients).
    const secFetchMode = req.headers['sec-fetch-mode'];
    if (secFetchMode === 'no-cors') {
      throw new ForbiddenError(`Unsafe fetch mode rejected (sec-fetch-mode=${secFetchMode}).`);
    }

    // `Sec-Fetch-Dest` describes how the browser will use the response.
    // For a state-changing API endpoint the only legitimate destinations are
    // `empty` (fetch/XHR) and `document` (form submission). Anything else -
    // `image`, `script`, `style`, `audio`, `video`, `font`, `object`,
    // `embed`, `iframe` - indicates someone is trying to smuggle the request
    // through a resource-loading tag, which is a CSRF tell.
    const secFetchDest = req.headers['sec-fetch-dest'];
    if (typeof secFetchDest === 'string' && secFetchDest !== 'empty' && secFetchDest !== 'document') {
      throw new ForbiddenError(`Unsafe fetch destination rejected (sec-fetch-dest=${secFetchDest}).`);
    }

    const origin = req.headers['origin'] as string | undefined;
    const referer = req.headers['referer'] as string | undefined;

    // Build allowed origins from environment variable and localhost for development
    const allowedOrigins: string[] = [];

    if (process.env.APP_URL) {
      allowedOrigins.push(process.env.APP_URL);
    } else {
      // Fail closed: an unset APP_URL previously produced an empty allow-list
      // that would reject all requests, but made misconfiguration silent.
      // Failing loudly here surfaces the missing env var on the first
      // state-changing request rather than burying it under 403s.
      throw new ForbiddenError('CSRF: APP_URL is not configured on this deployment.');
    }

    // In dev, allow any localhost origin (Next.js may start on any available port)
    if (process.env.APP_URL?.includes('localhost')) {
      if (origin) {
        try {
          const url = new URL(origin);
          if (url.hostname === 'localhost') {
            allowedOrigins.push(url.origin);
          }
        } catch {
          /* ignore invalid origin */
        }
      }
      if (referer) {
        try {
          const url = new URL(referer);
          if (url.hostname === 'localhost') {
            allowedOrigins.push(url.origin);
          }
        } catch {
          /* ignore invalid referer */
        }
      }
    }

    // Check if request has valid origin or referer
    // Use URL parsing to prevent subdomain bypass attacks (e.g., app.example.com.attacker.com)
    const isValidOriginOrReferer = (header: string | undefined): boolean => {
      if (!header) return false;
      try {
        const url = new URL(header);
        return allowedOrigins.includes(url.origin);
      } catch {
        return false;
      }
    };

    const hasValidOrigin = isValidOriginOrReferer(origin);
    const hasValidReferer = isValidOriginOrReferer(referer);

    if (!hasValidOrigin && !hasValidReferer) {
      throw new ForbiddenError('Invalid request origin. CSRF protection triggered.');
    }

    next();
  };
};
