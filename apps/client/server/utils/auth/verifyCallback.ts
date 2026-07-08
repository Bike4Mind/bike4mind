import { AuthStrategy, IAuthProviders } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { omit } from 'lodash';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { ForbiddenError } from '@server/utils/errors';
import {
  isProviderEmailVerified,
  selectProviderEmail,
  ACCOUNT_LINK_VERIFICATION_REQUIRED,
  ACCOUNT_LINK_EMAIL_MISMATCH,
} from './oauthAccountLink';
import { OAuthFailureReason } from './oauthFailureReason';

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
