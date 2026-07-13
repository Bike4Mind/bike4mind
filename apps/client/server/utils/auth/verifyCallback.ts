import { AuthStrategy, IAuthProviders } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { randomUUID } from 'crypto';
import { omit } from 'lodash';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { ForbiddenError } from '@server/utils/errors';
import { isProviderEmailVerified, selectProviderEmail, decideAutoLink } from './oauthAccountLink';
import { OAuthFailureReason } from './oauthFailureReason';

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
          `[verifyCallback] oauth create: username "${safe(baseUsername)}" was taken - created "${safe(candidate)}" (retry ${retry})`
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

      let promoteEmailVerified = false;
      if (!existingSameIdentity) {
        // Shared account-takeover gate (see decideAutoLink). This path feeds it the
        // passport email-array shape via isProviderEmailVerified(); okta/callback.ts
        // feeds the OIDC boolean. Both consume one decision so the two paths can't drift.
        const decision = decideAutoLink({
          providerEmailVerified: isProviderEmailVerified(profile),
          providerEmail: email,
          localEmail: user.email ?? null,
          localEmailVerified: user.emailVerified === true,
          hasUsablePassword: !!user.hasUsablePassword,
        });
        if (decision.action === 'refuse') {
          // Propagate the targeted email so [strategy]/callback.ts can write
          // it onto the auth-fail log row for forensic review during attacks.
          done(decision.reason, undefined, email ? { email } : undefined);
          return;
        }
        promoteEmailVerified = decision.action === 'promote-and-link';
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
        emailVerified?: boolean;
        emailVerifiedAt?: Date;
      };
      // Promotion write rides the SAME updateOne as the provider link - no second
      // round-trip, and it can never persist without the link (or vice versa).
      // Promotion only fires on a real email match (see above), so the local email
      // is always present here - no backfill needed.
      const emailVerifiedAt = new Date();
      const emailVerifiedFields: { emailVerified?: boolean; emailVerifiedAt?: Date } = promoteEmailVerified
        ? { emailVerified: true, emailVerifiedAt }
        : {};
      if (isNewProvider) {
        await User.updateOne(
          { _id: user._id },
          { $set: { oauthCredentials, authProviders, ...emailVerifiedFields }, $inc: { tokenVersion: 1 } }
        );
        linkedUser.tokenVersion = (user.tokenVersion ?? 0) + 1;
      } else {
        await User.updateOne({ _id: user._id }, { oauthCredentials, authProviders, ...emailVerifiedFields });
      }
      if (promoteEmailVerified) {
        linkedUser.emailVerified = true;
        linkedUser.emailVerifiedAt = emailVerifiedAt;
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
    // attach a canonical, data-free `code` the callback can safely record -
    // the raw `message` rides along only for the callback's console.error
    // (CloudWatch), never for the audit reason or redirect.
    console.error('[verifyCallback] authenticateUser threw:', e);
    const code: OAuthFailureReason = isDuplicateKeyError(e)
      ? 'duplicate_account'
      : e instanceof ForbiddenError
        ? 'forbidden_system_user'
        : 'internal';
    done(null, undefined, {
      code,
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
