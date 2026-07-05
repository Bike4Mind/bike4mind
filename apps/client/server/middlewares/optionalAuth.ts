import passport from 'passport';
import type { Request, Response, NextFunction } from 'express';
import { apiKeyAuth } from '@server/middlewares/apiKeyAuth';

/**
 * Optional authentication for public-facing publish surfaces. Populates
 * `req.user` when the caller presents a valid `X-API-Key` OR a valid Bearer
 * JWT, but NEVER rejects an anonymous request - anonymous viewers must still be
 * able to read a public artifact's comments.
 *
 * The comment overlay widget runs same-origin on the app host, reads the
 * viewer's B4M token from localStorage, and sends it as `Authorization: Bearer`
 * - so a signed-in viewer is recognized here and may write. (This same-origin
 * token access is exactly the capability denied to author bundle JS, which is
 * stripped at serve time; only B4M's own trusted overlay can use it.)
 *
 * Writes are gated separately: the route checks `req.user` is present (and the
 * artifact's commentPolicy) before allowing a create. A present-but-INVALID
 * X-API-Key still short-circuits with 401 inside apiKeyAuth (same as the serve
 * handler) - only the *absence* of credentials is treated as anonymous.
 */
const apiKeyShim = apiKeyAuth();

export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1) X-API-Key shim - passes through when no key; 401s on an invalid key.
  let shimDone = false;
  await new Promise<void>((resolve, reject) => {
    const cb: NextFunction = (err?: unknown) => {
      shimDone = true;
      if (err) return reject(err instanceof Error ? err : new Error(String(err)));
      resolve();
    };
    Promise.resolve(apiKeyShim(req, res, cb))
      .then(() => {
        if (!shimDone) resolve();
      })
      .catch(reject);
  });
  if (res.headersSent) return;
  if (req.user) return next();

  // 2) Optional Bearer JWT - only when a Bearer Authorization header is present
  //    (skip `ApiKey ...` and other schemes so we don't run the JWT strategy or
  //    log warnings for non-JWT credentials). Fails OPEN to anonymous on an
  //    invalid/expired token (reads stay gated by checkVisibility; writes still
  //    require req.user). Strategy errors are logged for observability.
  if (req.headers.authorization?.startsWith('Bearer ')) {
    await new Promise<void>(resolve => {
      passport.authenticate('jwt', { session: false }, (err: Error | null, user: Express.User | false) => {
        if (err) req.logger?.warn(`[optionalAuth] JWT verify error (continuing anonymous): ${err.message}`);
        if (user) req.user = user;
        resolve();
      })(req, res, () => resolve());
    });
  }

  return next();
}
