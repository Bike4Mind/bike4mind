import { AuthStrategy, IAuthProviders } from '@bike4mind/common';
import { User, authSessionRepository } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { omit } from 'lodash';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { ForbiddenError } from '@server/utils/errors';
import { isProviderEmailVerified, selectProviderEmail, decideAutoLink, applyAccountLink } from './oauthAccountLink';
import { createUniqueOAuthUser, deriveOAuthUsername } from './createOAuthUser';
import { OAuthFailureReason } from './oauthFailureReason';
import { isOpenRegistrationAllowed } from './openRegistration';

/**
 * Strategies where anyone on the internet can present an identity, so a first login
 * is a self-serve signup and must obey the invite-only switch. SAML and Okta are
 * absent on purpose: an admin had to register that IdP for the domain first, which is
 * the authorization - gating them would break enterprise onboarding on instances that
 * are invite-only for the public.
 */
const SELF_SERVE_STRATEGIES: ReadonlySet<AuthStrategy> = new Set([AuthStrategy.Google, AuthStrategy.Github]);

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
  // SAML identity is (nameID, samlIdentityProviderId), never nameID alone: a nameID is
  // unique within one IdP but nothing stops two IdPs minting the same one, and for SAML
  // `id` above IS the nameID. Without this discriminator any registered IdP can assert a
  // nameID belonging to another IdP's tenant and match that tenant's user on stage 1 -
  // the domain bind in server/auth/auth.ts guards the asserted *email*, which a stage-1
  // hit never consults. Mirrors the oktaIdentityProviderId comparison in
  // pages/api/auth/okta/callback.ts; null for strategies that have no per-IdP notion
  // (Google, GitHub), where it adds no constraint.
  const samlIdpId = authProvider?.samlIdentityProviderId ?? null;
  const idpScope = samlIdpId ? { samlIdentityProviderId: samlIdpId } : {};

  try {
    // Stage 1: match by immutable (strategy, providerId).
    // Guard: only when id is truthy - $elemMatch with id:null would match other
    // users' legacy null-id rows and introduce a new null-collision takeover.
    let user = id ? await User.findOne({ authProviders: { $elemMatch: { strategy, id, ...idpScope } } }) : null;

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
      // a stage-1 hit on a later entry could be mis-evaluated here. Duplicates
      // are now collapsed on write (applyAccountLink) and on save (UserModel
      // pre-save guard), so such rows self-heal on the next login.
      // The samlIdpId clause is the refresh-exemption half of the same (nameID, IdP)
      // identity above: without it a cross-IdP nameID collision that reached this point
      // would be treated as "the same identity we already linked" and skip the gate
      // entirely. Vacuous for strategies with no per-IdP discriminator.
      const existingSameIdentity =
        existingProviderIndex !== -1 &&
        !!incomingId &&
        authProviders[existingProviderIndex].id === incomingId &&
        (!samlIdpId || authProviders[existingProviderIndex].samlIdentityProviderId === samlIdpId);

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

      // Shared account-link write (see applyAccountLink): the tokenVersion bump on
      // a new link and the emailVerified promotion stay in lockstep with
      // okta/callback.ts. Mutates authProviders in place, so it must run BEFORE the
      // omit(user) below for linkedUser to observe the linked provider.
      const { update, reflect } = applyAccountLink({
        authProviders,
        oauthCredentials,
        isNewProvider,
        promoteEmailVerified,
        currentTokenVersion: user.tokenVersion,
      });
      await User.updateOne({ _id: user._id }, update);

      // Invariant: a tokenVersion bump must also revoke AuthSessions, or an opaque refresh token
      // (which carries no tokenVersion and is never checked against it) would rotate straight into a
      // fresh access token stamped with the NEW version, defeating the "link a new provider revokes
      // other sessions" security bump. applyAccountLink only bumps tokenVersion on a new-provider
      // link, so gate the revoke on the same condition. Safe to revoke ALL here: the session for THIS
      // login is minted later, in the callback handler, so it is created fresh and unaffected.
      if (isNewProvider) {
        await authSessionRepository.revokeAllByUserId(String(user._id));
      }

      const linkedUser = omit(user, ['password']) as typeof user & {
        tokenVersion?: number;
        isNewOAuthLink?: boolean;
        emailVerified?: boolean;
        emailVerifiedAt?: Date;
      };
      // Reflect the persisted tokenVersion/emailVerified onto the returned user so
      // the token minted for this login matches what was just written.
      Object.assign(linkedUser, reflect);
      // Transient flag (not persisted) so the callback endpoint can distinguish
      // a genuine new account-link from a routine re-login and audit accordingly.
      linkedUser.isNewOAuthLink = isNewProvider;
      done(null, linkedUser);
    } else {
      // Invite gate. `registerUser` refuses a code-less signup on an invite-only
      // instance, but this path creates accounts with User.create and never reaches it,
      // so a closed instance still accepted any Google/GitHub first login.
      //
      // Enterprise SSO is deliberately exempt (see SELF_SERVE_STRATEGIES): registering
      // the IdP is itself the admin's authorization for that domain's users.
      if (SELF_SERVE_STRATEGIES.has(strategy) && !(await isOpenRegistrationAllowed())) {
        done(null, undefined, { code: 'registration_closed' });
        return;
      }

      const name = profile?.displayName ?? profile?.name ?? username ?? '';
      // Gate the provider-asserted email out of a brand-new account's login
      // identity unless the provider marked it verified. An unverified email
      // persisted here becomes a Stage-2 match key (the email $or above) that a
      // later verified sign-in for the same address would auto-link into (see
      // decideAutoLink), handing this account to whoever created it. SAML's
      // wrapper synthesizes verified:true, so IdP-attested logins still persist
      // their email; sibling OAuth create paths must apply the same gate.
      const emailForNewAccount = isProviderEmailVerified(profile) ? email : null;
      const baseUsername = deriveOAuthUsername(username, name, emailForNewAccount);
      user = await createUniqueOAuthUser({ name, baseUsername, email: emailForNewAccount, oauthCredentials });
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
