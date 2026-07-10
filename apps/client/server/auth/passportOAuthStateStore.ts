import { Request } from 'express';
import OAuth2Strategy from 'passport-oauth2';
import { createStateToken, verifyStateToken } from './jwtStateStore';
import { STATE_REASON_TO_CODE } from '@server/utils/auth/oauthFailureReason';

type Metadata = OAuth2Strategy.Metadata;
type StoreCallback = OAuth2Strategy.StateStoreStoreCallback;
type VerifyCallback = OAuth2Strategy.StateStoreVerifyCallback;

/**
 * Passport-oauth2 StateStore adapter backed by JWT state tokens.
 *
 * Implements the OAuth2Strategy.StateStore interface for use with
 * passport-github and passport-google-oauth20. A custom store is required
 * here because the app runs session: false; the default SessionStore needs
 * req.session.
 *
 * Stateless tradeoff: tokens are short-lived (5m, HS256-signed) but not
 * single-use. A captured state param is replayable within the window - the
 * same accepted tradeoff as the Okta and Slack state stores in this codebase.
 *
 * At runtime passport-oauth2 v1.8.0 dispatches by arity:
 *   store: 3-arg -> store(req, meta, cb)
 *   verify: 4-arg -> verify(req, state, meta, cb)
 */
export class PassportOAuthStateStore implements OAuth2Strategy.StateStore {
  private readonly audience: string;

  constructor(audience: string) {
    this.audience = audience;
  }

  store(req: Request, callback: StoreCallback): void;
  store(req: Request, meta: Metadata, callback: StoreCallback): void;
  store(req: Request, metaOrCallback: Metadata | StoreCallback, callback?: StoreCallback): void {
    const cb = (typeof metaOrCallback === 'function' ? metaOrCallback : callback) as StoreCallback;
    try {
      // Carry the post-login redirect target through the IdP round-trip by
      // embedding it in the signed state JWT (read back in the OAuth callback).
      // Sanitized client-side before navigation in /auth/success, so passed
      // through opaquely here.
      const redirectTo = typeof req.query?.redirectTo === 'string' ? req.query.redirectTo : undefined;
      const token = createStateToken({ audience: this.audience }, redirectTo ? { redirectTo } : undefined);
      cb(null, token);
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)), undefined);
    }
  }

  verify(req: Request, state: string, callback: VerifyCallback): void;
  verify(req: Request, state: string, meta: Metadata, callback: VerifyCallback): void;
  verify(req: Request, state: string, metaOrCallback: Metadata | VerifyCallback, callback?: VerifyCallback): void {
    const cb = (typeof metaOrCallback === 'function' ? metaOrCallback : callback) as VerifyCallback;
    try {
      const result = verifyStateToken(state, { audience: this.audience });
      if (result.valid) {
        cb(null, true, result.payload);
      } else {
        cb(null, false, { code: STATE_REASON_TO_CODE[result.reason], message: result.message });
      }
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)), false, undefined);
    }
  }
}

export const githubOAuthStateStore = new PassportOAuthStateStore('github-oauth-state');
export const googleOAuthStateStore = new PassportOAuthStateStore('google-oauth-state');
