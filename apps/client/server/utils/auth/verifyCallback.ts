import { AuthStrategy, IAuthProviders } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { omit } from 'lodash';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import {
  isProviderEmailVerified,
  selectProviderEmail,
  ACCOUNT_LINK_VERIFICATION_REQUIRED,
  ACCOUNT_LINK_EMAIL_MISMATCH,
} from './oauthAccountLink';

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
    // .select('+password') - `password` is `select: false` in the schema, and the
    // auto-link gate below needs to tell a pure-OAuth shell (no password) from a
    // password-protected account; without this every user would look passwordless.
    let user = id ? await User.findOne({ authProviders: { $elemMatch: { strategy, id } } }).select('+password') : null;

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
      user = await User.findOne({ $or: conditions }).select('+password');
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
        const providerEmailVerified = isProviderEmailVerified(profile);
        if (!providerEmailVerified) {
          // Propagate the targeted email so [strategy]/callback.ts can write
          // it onto the auth-fail log row for forensic review during attacks.
          done(ACCOUNT_LINK_VERIFICATION_REQUIRED, undefined, email ? { email } : undefined);
          return;
        }
        // The provider email is verified but it must also match the local
        // account's email (case-insensitive). Verification alone is not sufficient:
        // an attacker with a verified email on a colliding username could otherwise
        // link into a victim account.
        const localEmail = user.email ?? null;
        if (email && localEmail && email.toLowerCase() !== localEmail.toLowerCase()) {
          done(ACCOUNT_LINK_EMAIL_MISMATCH, undefined, { email });
          return;
        }
        // Local-verified half: required UNLESS the local account is a pure-OAuth
        // shell (no password). A password-protected account with an unverified
        // email is a classic reverse-takeover setup - an attacker pre-creates the
        // victim's email locally (unverified, password known only to the attacker)
        // and waits for the victim to SSO in and get absorbed. A passwordless shell
        // can't be squatted that way, and the provider round-trip above just
        // cryptographically attested control of this email, so linking is safe -
        // promote the local email to verified instead of dead-ending the user.
        // Promote ONLY on a real verified-email match, though: a username-only
        // match (local email null) is not an identity assertion, so promoting on it
        // would let a colliding username link into an emailless passwordless shell
        // and stamp the attacker's email onto it.
        if (user.emailVerified !== true) {
          if (!user.password && email && localEmail && email.toLowerCase() === localEmail.toLowerCase()) {
            promoteEmailVerified = true;
          } else {
            done(ACCOUNT_LINK_VERIFICATION_REQUIRED, undefined, email ? { email } : undefined);
            return;
          }
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
      user = await User.create({
        name,
        username: username ?? name,
        password: null,
        isAdmin: false,
        oauthCredentials,
        authProviders: [oauthCredentials],
        ...(email ? { email } : {}),
      });
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
