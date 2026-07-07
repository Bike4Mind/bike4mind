import { AuthStrategy, IAuthProviders } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { randomUUID } from 'crypto';
import { omit } from 'lodash';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import {
  isProviderEmailVerified,
  selectProviderEmail,
  ACCOUNT_LINK_VERIFICATION_REQUIRED,
  ACCOUNT_LINK_EMAIL_MISMATCH,
} from './oauthAccountLink';

// Bounded retries for the username-collision dedupe below. Not a tunable -
// six total create attempts (base + 5 retries) is already generous for a
// username collision; if that many are exhausted something else is wrong.
const MAX_USERNAME_RETRIES = 5;

/** True only for a MongoDB E11000 on the `username` unique index specifically. */
function isUsernameDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && !!e.keyPattern && 'username' in e.keyPattern;
}

/**
 * Derive the username for a brand-new OAuth account. Providers rarely give a
 * stable, unique handle (Google has no `username` field at all - only a
 * displayName), so this can legitimately be empty; User.create requires a
 * non-empty username, so fall back to the email local-part, then a random
 * handle. Never return ''.
 */
function deriveOAuthUsername(rawUsername: string | null, name: string, email: string | null): string {
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
 * Optimistic-create-then-retry (not check-then-create) so this is race-safe
 * under concurrent signups. Only retries on a USERNAME collision - a
 * collision on the `email` unique index is a different, much rarer case (a
 * concurrent same-email signup race, since Stage 2 above already excludes a
 * non-race match) and is deliberately NOT retried here: re-matching and
 * returning the other create's user would hand out an account without ever
 * running the account-link security gate above. Letting it throw sends it to
 * the outer catch, which fails clean; a real retry (e.g. a page reload) then
 * goes through Stage 1/2 and links properly through the gate.
 */
async function createUniqueOAuthUser(params: {
  name: string;
  baseUsername: string;
  email: string | null;
  oauthCredentials: Record<string, unknown>;
}) {
  const { name, baseUsername, email, oauthCredentials } = params;
  const buildDoc = (username: string) => ({
    name,
    username,
    password: null,
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
        console.info(
          `[verifyCallback] oauth create: username "${baseUsername}" was taken - created "${candidate}" (retry ${retry})`
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

// Core authentication logic shared by all strategies
const authenticateUser = async (
  strategy: AuthStrategy,
  accessToken: string,
  refreshToken: string,
  profile: any,
  done: any,
  authProvider?: Partial<IAuthProviders>
) => {
  const selectedEmail = selectProviderEmail(profile)?.value;
  const email = typeof selectedEmail === 'string' ? selectedEmail : null;
  const username = profile?.username ?? profile?.preferred_username ?? null;
  const id = profile?.id ?? profile?.sub ?? null;

  try {
    // Stage 1: match by immutable (strategy, providerId).
    // Guard: only when id is truthy - $elemMatch with id:null would match other
    // users' legacy null-id rows and introduce a new null-collision takeover.
    let user = id ? await User.findOne({ authProviders: { $elemMatch: { strategy, id } } }) : null;

    // Stage 2: fallback to mutable email/username only when stage 1 missed.
    // The Missing Identifier guard lives here (between stages) because a stage-1
    // hit needs no email/username. Also, User.findOne({ $or: [] }) throws, so
    // we must not build stage-2 unless at least one condition is present.
    if (!user) {
      if (!email && !username) {
        done('Missing Identifier');
        return;
      }
      const conditions: { [field: string]: { $regex: string; $options: string } }[] = [];
      if (email) conditions.push({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } });
      if (username) conditions.push({ username: { $regex: `^${escapeRegex(username)}$`, $options: 'i' } });
      user = await User.findOne({ $or: conditions });
    }

    const oauthCredentials = {
      id,
      strategy,
      refreshToken,
      accessToken,
      ...(authProvider ?? {}),
    };

    if (user) {
      requireNonSystemUser(user);
      const authProviders = user.authProviders || [];
      const existingProviderIndex = authProviders.findIndex(
        provider => provider.strategy === oauthCredentials.strategy
      );

      const isNewProvider = existingProviderIndex === -1;

      // Security gate: auto-linking a NEW provider - or replacing an
      // existing entry with a DIFFERENT provider identity (sub/id) - to an
      // existing local account is a federated-identity account-takeover vector
      // unless both sides of the email assertion are verified. Token refresh
      // for the SAME provider identity is exempt - that binding was already
      // made previously.
      //
      // `incomingId` truthiness guard: legacy authProvider rows may carry
      // `id: null` (the schema doesn't validate the field); without the guard
      // a `null === null` strict-equality bypass would trip the gate. Refresh
      // is only safe when we can actually point at a non-empty stored sub.
      const incomingId = oauthCredentials.id;
      // NOTE: existingProviderIndex is the FIRST entry for this strategy. If an
      // account ever holds multiple entries for one strategy with different ids,
      // a stage-1 hit on a later entry could be mis-evaluated here. The upsert
      // path prevents creating such duplicates today; may need further hardening.
      const existingSameIdentity =
        existingProviderIndex !== -1 && !!incomingId && authProviders[existingProviderIndex].id === incomingId;

      if (!existingSameIdentity) {
        const providerEmailVerified = isProviderEmailVerified(profile);
        const localEmailVerified = user.emailVerified === true;
        if (!providerEmailVerified || !localEmailVerified) {
          // Propagate the targeted email so [strategy]/callback.ts can write
          // it onto the auth-fail log row for forensic review during attacks.
          done(ACCOUNT_LINK_VERIFICATION_REQUIRED, undefined, email ? { email } : undefined);
          return;
        }
        // Both emails are verified but they must also match (case-insensitive).
        // Verification alone is not sufficient: an attacker with a verified email
        // on a colliding username/email could otherwise link into a victim account.
        const localEmail = user.email ?? null;
        if (email && localEmail && email.toLowerCase() !== localEmail.toLowerCase()) {
          done(ACCOUNT_LINK_EMAIL_MISMATCH, undefined, { email });
          return;
        }
      }

      if (existingProviderIndex !== -1) {
        authProviders[existingProviderIndex] = oauthCredentials;
      } else {
        authProviders.push(oauthCredentials);
      }

      // Linking a NEW auth provider to an existing account is a security-relevant
      // change: bump tokenVersion to invalidate any other active sessions. The
      // session being established here is kept valid by reflecting the new
      // version on the returned user, so the token minted for this login matches.
      const linkedUser = omit(user, ['password']) as typeof user & {
        tokenVersion?: number;
        isNewOAuthLink?: boolean;
      };
      if (isNewProvider) {
        await User.updateOne(
          { _id: user._id },
          { $set: { oauthCredentials, authProviders }, $inc: { tokenVersion: 1 } }
        );
        linkedUser.tokenVersion = (user.tokenVersion ?? 0) + 1;
      } else {
        await User.updateOne({ _id: user._id }, { oauthCredentials, authProviders });
      }
      // Transient flag (not persisted) so the callback endpoint can distinguish
      // a genuine new account-link from a routine re-login and audit accordingly.
      linkedUser.isNewOAuthLink = isNewProvider;
      done(null, linkedUser);
    } else {
      const name = profile?.displayName ?? profile?.name ?? username ?? '';
      const baseUsername = deriveOAuthUsername(username, name, email);
      user = await createUniqueOAuthUser({ name, baseUsername, email, oauthCredentials });
      // Transient flag (not persisted), mirroring isNewOAuthLink above: lets
      // the callback endpoint log the registration and forward a one-shot
      // signup signal to the client for ad-conversion tracking.
      const createdUser = omit(user, ['password']) as typeof user & { isNewUser?: boolean };
      createdUser.isNewUser = true;
      done(null, createdUser);
    }
  } catch (e) {
    // Never swallow silently. The bare `done(null)` here destroyed the
    // exception before it could reach [strategy]/callback.ts, surfacing every
    // failure (duplicate-key writes, system-user rejection, DB errors) as an
    // opaque "OAuth user not returned" with no reason. Log the real error and
    // pass a non-empty info message so the callback can record something useful.
    console.error('[verifyCallback] authenticateUser threw:', e);
    done(null, undefined, {
      message: e instanceof Error ? e.message : 'Internal error during authentication',
    });
  }
};

// OAuth callback wrapper - handles different signature variations
export const verifyCallback = (strategy: AuthStrategy) => {
  return async (accessToken: string, refreshToken: string, ...rest: any[]) => {
    // Different OAuth providers call with different signatures:
    // - Standard (GitHub): (accessToken, refreshToken, profile, done)
    // - With params (Google): (accessToken, refreshToken, params, profile, done)
    // - With custom data (SAML): (accessToken, refreshToken, profile, done, authProvider)

    if (rest.length === 2) {
      // Standard: (profile, done)
      return authenticateUser(strategy, accessToken, refreshToken, rest[0], rest[1]);
    } else if (rest.length === 3 && typeof rest[2] === 'function') {
      // With params: (params, profile, done)
      return authenticateUser(strategy, accessToken, refreshToken, rest[1], rest[2]);
    } else {
      // With custom data: (profile, done, authProvider)
      return authenticateUser(strategy, accessToken, refreshToken, rest[0], rest[1], rest[2]);
    }
  };
};
