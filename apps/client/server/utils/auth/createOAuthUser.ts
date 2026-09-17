import { User } from '@bike4mind/database';
import { randomUUID } from 'crypto';

// Bounded retries for the username-collision dedupe below. Not a tunable -
// six total create attempts (base + 5 retries) is already generous for a
// username collision; if that many are exhausted something else is wrong.
const MAX_USERNAME_RETRIES = 5;

/**
 * True only for a MongoDB E11000 on the `username` unique index specifically.
 * Requires a SINGLE-key keyPattern of exactly `username`: today the only unique
 * indexes are single-field (`username_1`, partial `email_1`), but if the compound
 * `{username, email}` index ever became unique its keyPattern would contain
 * `username` too - the length guard keeps this from being mis-classified as a
 * plain username collision (which would then retry with the same colliding email).
 */
function isUsernameDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && !!e.keyPattern && Object.keys(e.keyPattern).length === 1 && 'username' in e.keyPattern;
}

/**
 * Derive the username for a brand-new OAuth account. Providers rarely give a
 * stable, unique handle (Google has no `username` field at all - only a
 * displayName), so this can legitimately be empty; User.create requires a
 * non-empty username, so fall back to the email local-part, then a random
 * handle. Never return ''.
 */
export function deriveOAuthUsername(rawUsername: string | null, name: string, email: string | null): string {
  const base = rawUsername ?? name;
  if (base) return base;
  const emailLocalPart = email?.split('@')[0];
  if (emailLocalPart) return emailLocalPart;
  return `user-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a new OAuth user, retrying with a disambiguated username on a
 * collision. This is what closes the "Google displayName collides with an
 * existing username" lockout: OAuth-derived usernames aren't unique by
 * construction, so a plain create can E11000 on the `username` index and
 * fail the whole sign-in with an opaque error.
 *
 * Shared by every OAuth create path (verifyCallback.ts for Google/GitHub/SAML,
 * okta/callback.ts for Okta OIDC) so the collision-retry and empty-name guards
 * can never drift between them.
 *
 * Optimistic-create-then-retry (not check-then-create) so this is race-safe
 * under concurrent signups. Only retries on a USERNAME collision - a
 * collision on the `email` unique index is a different, much rarer case (a
 * concurrent same-email signup race, since the Stage-2 lookup already excludes a
 * non-race match) and is deliberately NOT retried here: re-matching and
 * returning the other create's user would hand out an account without ever
 * running the account-link security gate. Letting it throw sends it to the
 * caller's outer catch, which fails clean; a real retry (e.g. a page reload)
 * then goes through Stage 1/2 and links properly through the gate.
 */
export async function createUniqueOAuthUser(params: {
  name: string;
  baseUsername: string;
  email: string | null;
  oauthCredentials: Record<string, unknown>;
}) {
  const { name, baseUsername, email, oauthCredentials } = params;
  // `name` is a required field. Providers that send neither a displayName/name
  // nor a username (a minimal OIDC/SAML assertion carrying only an email) would
  // otherwise create with name='' -> a non-E11000 validation error that is not
  // retried and fails the whole sign-in - the same class of opaque OAuth-create
  // lockout this helper exists to prevent. baseUsername is guaranteed non-empty.
  const safeName = name || baseUsername;
  const buildDoc = (username: string) => ({
    name: safeName,
    username,
    password: null,
    hasUsablePassword: false,
    isAdmin: false,
    oauthCredentials,
    authProviders: [oauthCredentials],
    ...(email ? { email } : {}),
  });

  let candidate = baseUsername;
  for (let retry = 0; retry <= MAX_USERNAME_RETRIES; retry++) {
    try {
      const user = await User.create(buildDoc(candidate));
      if (retry > 0) {
        // Strip control chars before logging: baseUsername/candidate derive from
        // the provider displayName (attacker-controllable) and this is raw console
        // output, so a CRLF/ANSI-laden display name could forge adjacent log lines.
        const safe = (s: string) => s.replace(/[\r\n\t]/g, ' ');
        console.info(
          `[oauth create] username "${safe(baseUsername)}" was taken - created "${safe(candidate)}" (retry ${retry})`
        );
      }
      return user;
    } catch (err) {
      if (!isUsernameDuplicateKeyError(err) || retry === MAX_USERNAME_RETRIES) {
        throw err;
      }
      // Readable increments for the common case (one or two prior accounts
      // with the same display name); a short random suffix on the final
      // retry in case the numeric suffixes are also taken.
      candidate =
        retry < MAX_USERNAME_RETRIES - 1
          ? `${baseUsername} ${retry + 2}`
          : `${baseUsername}-${randomUUID().slice(0, 6)}`;
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error('createUniqueOAuthUser: exhausted retries');
}
