import passport from '@server/auth/auth';
import ability from '@server/auth/ability';
import type { Request, Response, NextFunction } from 'express';

/**
 * Optional Bearer-JWT shim for routes mounted with `baseApi({ auth: false })`.
 *
 * It runs the SAME registered passport `jwt` strategy the normal `auth` handler uses
 * (secret-rotation + tokenVersion kill-switch + isSystem reject - see auth.ts), but with
 * a custom callback so a valid `Authorization: Bearer <jwt>` populates `req.user` while a
 * MISSING or INVALID token simply passes through (no 401). That pass-through is the whole
 * point: anonymous public viewing must keep working, and a stale/garbage token must
 * degrade to "anonymous", not error.
 *
 * Used by the publish viewer (`/api/publish/serve/[...path]`) so the client-side
 * loader's `Authorization: Bearer` re-fetch can satisfy the visibility gate, alongside the
 * existing `X-API-Key` shim. Run this BEFORE `apiKeyAuth()` - apiKeyAuth early-returns when
 * `req.user` is already set, so Bearer wins and ApiKey still works when no Bearer is present.
 */
export const optionalJwtAuth = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user) return next();
    // Only a Bearer token is a JWT; `ApiKey ...` is left for the apiKeyAuth shim. The scheme
    // is case-insensitive (RFC 6750 §2.1) and ExtractJwt matches it as such, so match it that
    // way here too - a `bearer ...` header should take the JWT path, not fall through.
    if (!/^Bearer\s/i.test(req.headers.authorization ?? '')) return next();

    passport.authenticate('jwt', { session: false }, (err: unknown, user: Express.User | false | null) => {
      // Degrade to anonymous on err / !user - the inverse of the `auth` handler, which 401s.
      // A bare absent/invalid token (!user) is the normal anonymous path and stays silent, but
      // a strategy ERROR (err) can signal a real misconfig (e.g. a botched JWT secret rotation)
      // that would otherwise silently downgrade every viewer to anonymous - log it so it's
      // observable while still not failing the request.
      if (err) req.logger?.warn('optionalJwtAuth: jwt strategy error, continuing anonymously', err);
      // Degrade a pre-MFA (mfaPending) session to anonymous. The JWT strategy stamps
      // mfaPending onto req.user and returns it as a success; the normal full-auth chain has a
      // separate middleware that blocks mfaPending users, but this route is `auth: false` and
      // bypasses it - so we must mirror that policy here or a username+password session that
      // hasn't completed MFA could view gated bundles. Such a viewer falls through to the
      // loader shell's sign-in branch, the correct posture for a pre-MFA session.
      const u = user as (Express.User & { mfaPending?: boolean }) | false | null;
      if (err || !u || u.mfaPending) return next();
      req.user = u;
      req.ability = ability(u as Parameters<typeof ability>[0]);
      next();
    })(req, res, next);
  };
};
