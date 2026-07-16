import { Request, Response, NextFunction } from 'express';

/**
 * Route-scoped CORS for the public embed surfaces. A plain Express handler (no
 * next-connect specifics), so the Next mint route (`baseApi().use(embedCors())`)
 * and the Fargate chat route (`app.use`) share one implementation. Kept separate
 * from the global policy in `proxy.ts` (which excludes `/api`), so nothing global
 * is touched.
 *
 * This sets the response CORS headers and answers the OPTIONS preflight; it does
 * NOT decide whether an origin is approved. Preflight carries no credential, so
 * the allow-list can only be checked once the handler has resolved the key/token
 * - each embed handler enforces `isOriginPermitted(origin, allowedOrigins)` and
 * rejects a disallowed origin before doing any work. Echoing the requesting
 * origin here keeps that rejection (and every real response) readable by the
 * browser; a successful 200 is only ever produced for an approved origin.
 */
const ALLOW_METHODS = 'POST, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, X-API-Key, Authorization';

export function embedCors() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
