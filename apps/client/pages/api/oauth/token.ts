/**
 * POST /api/oauth/token
 *
 * OAuth 2.0 token endpoint. Handles only:
 * - grant_type=authorization_code  (PKCE for public clients, client_secret_post for confidential)
 * - grant_type=refresh_token       (relying-party clients only; rotated, grant-bound families)
 *
 * First-party/device refresh is a separate endpoint (POST /api/oauth/refresh); this one rejects any
 * other grant_type.
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { isTokenVersionCurrent, authSessionService } from '@bike4mind/services';
import {
  oauthAuthorizationCodeRepository,
  oauthClientRepository,
  oauthGrantRepository,
  oauthRefreshTokenRepository,
  userRepository,
} from '@bike4mind/database';
import { verifyPkce, validateClientSecret, validateClient, generateIdToken } from '@server/auth/oauthServer';
import { PKCE_CODE_VERIFIER_RE } from '@server/auth/pkce';
import { issueSessionForRequest } from '@server/auth/issueSession';
import { ACCESS_TOKEN_TTL_SECONDS, authTokenGenerator } from '@server/auth/tokenGenerator';
import { grantCovers, oauthAccessTokenAudience } from '@server/auth/oauthConsent';
import { mintRefreshFamily, refreshFamilyExpiresAt } from '@server/auth/oauthRefreshToken';
import { assertAccountStateUsable } from '@server/auth/assertAccountStateUsable';

const AuthCodeRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string(),
  redirect_uri: z.string().url(),
  client_id: z.string(),
  // PKCE clients send code_verifier; confidential clients (e.g. Cognito) send client_secret instead.
  // Constrained to RFC 7636's grammar (43-128 unreserved chars) so a low-entropy verifier is rejected
  // at the boundary rather than hashed - the challenge is exposed at authorization, so a short
  // verifier would be offline-recoverable if the code were intercepted.
  code_verifier: z
    .string()
    .regex(PKCE_CODE_VERIFIER_RE, 'code_verifier must be 43-128 unreserved characters (RFC 7636)')
    .optional(),
  client_secret: z.string().optional(),
});

// RFC 6749 6. `scope` may narrow (never widen) the family's scopes for this response only.
const RefreshRequestSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
});

function idTokenUserParams(user: { id: string; email?: string | null; username?: string; oauthCredentials?: unknown }) {
  const email = user.email ?? '';
  return {
    userId: user.id,
    email,
    name: user.username || email.split('@')[0],
    picture: (user.oauthCredentials as { picture?: string } | undefined)?.picture ?? null,
  };
}

const invalidGrant = { error: 'invalid_grant', error_description: 'Invalid refresh token' };

const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: 20, windowMs: 60 * 1000 }))
  .post(async (req, res) => {
    const { grant_type } = req.body;

    if (grant_type === 'authorization_code') {
      const parsed = AuthCodeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
      }

      const { code, redirect_uri, client_id, code_verifier, client_secret } = parsed.data;

      // Load the client and validate the redirect_uri (RFC 6749 3.1.2.3).
      const client = await validateClient(client_id, redirect_uri);
      if (!client) {
        return res
          .status(401)
          .json({ error: 'unauthorized_client', error_description: 'Invalid client_id or redirect_uri' });
      }

      // Confidential clients MUST authenticate at the token endpoint (RFC 6749
      // 3.2.1 / 4.1.3). Classification decides, not the mere presence of a
      // secret - so a confidential client that omits or fails secret auth is
      // rejected, never allowed to fall through to redirect_uri-only checking.
      const isConfidential = client.tokenEndpointAuthMethod === 'client_secret_post';
      if (isConfidential) {
        const authed = client_secret ? await validateClientSecret(client_id, client_secret, redirect_uri) : null;
        if (!authed) {
          return res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication required' });
        }
      }

      // Read the code WITHOUT consuming it yet, so a request that fails the checks below - a
      // client_id/redirect_uri mismatch or a bad/absent PKCE verifier - does not burn a still-valid
      // single-use code and deny the legitimate client a corrected retry. Consumption is deferred to
      // the atomic step after validation passes.
      const authCode = await oauthAuthorizationCodeRepository.findValidCode(code);
      if (!authCode) {
        return res
          .status(400)
          .json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
      }

      // must match what was used during authorization
      if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
        return res
          .status(400)
          .json({ error: 'invalid_grant', error_description: 'client_id or redirect_uri mismatch' });
      }

      // PKCE enforcement (RFC 7636; RFC 9700 4.8.2 downgrade countermeasure).
      // Public clients MUST use PKCE: a code minted with no challenge cannot be
      // redeemed, which blocks replaying a challenge-less code without a secret.
      // Whenever a challenge was recorded the verifier must match - confidential
      // clients included.
      if (!isConfidential && !authCode.codeChallenge) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'PKCE required: no code_challenge was provided at authorization',
        });
      }
      if (authCode.codeChallenge) {
        if (!code_verifier || !verifyPkce(code_verifier, authCode.codeChallenge)) {
          return res
            .status(400)
            .json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' });
        }
      }

      // Validation passed - NOW atomically claim the code (findOneAndUpdate on used:false). A leaked
      // code still can't be redeemed twice: only one request flips used false->true; a loser, or a
      // code consumed between the read above and here, gets null and is rejected. Single-use is
      // preserved, while a validation failure above left the code live for a corrected retry.
      const consumed = await oauthAuthorizationCodeRepository.consumeValidCode(code);
      if (!consumed) {
        return res
          .status(400)
          .json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
      }

      const user = await userRepository.findById(authCode.userId);
      if (!user) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found' });
      }

      const idToken = generateIdToken({
        ...idTokenUserParams(user),
        clientId: client_id,
        scopes: authCode.scopes,
        // Only a relying-party grant is scope-limited; a first-party client keeps the full claim
        // set in the id_token, matching userinfo (releasedIdentityClaims).
        scopeLimited: client.clientType === 'relying-party',
        nonce: authCode.nonce,
      });

      // Relying-party clients get a scope/audience-bound OAuth access token, NOT a full first-party
      // session: no first-party refresh token, and the route gate (oauthRouteGate) default-denies it
      // everywhere except OAuth-reachable routes. Consent must already be recorded (the authorize
      // flow upserts the grant); re-check it here as defense in depth so a code minted before a
      // client was reclassified - or for a client whose grant was revoked - cannot be redeemed.
      if (client.clientType === 'relying-party') {
        const grant = await oauthGrantRepository.findGrant(user.id, client_id);
        if (!grant || !grantCovers(grant.scopes, authCode.scopes)) {
          return res.status(400).json({ error: 'access_denied', error_description: 'User consent required' });
        }

        const scopeStr = authCode.scopes.join(' ');
        const accessToken = authTokenGenerator.signAccessToken(user.id, user.tokenVersion ?? 0, {
          kind: 'oauth',
          client_id,
          scope: scopeStr,
          aud: oauthAccessTokenAudience(),
        });

        // A refresh token only with offline_access (OIDC Core 11); without it the relying party
        // re-authorizes through the browser flow, which its remembered consent makes silent.
        const refreshToken = authCode.scopes.includes('offline_access')
          ? await mintRefreshFamily({
              userId: user.id,
              clientId: client_id,
              scopes: authCode.scopes,
              tokenVersion: user.tokenVersion ?? 0,
            })
          : undefined;

        return res.json({
          access_token: accessToken,
          id_token: idToken,
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
          // RFC 6749 3.3: echo the granted scope so the client sees what it actually got.
          scope: scopeStr,
        });
      }

      // First-party clients keep the existing full first-party session (access + refresh), unchanged.
      const { accessToken, refreshToken } = await issueSessionForRequest(req, user.id, {
        createdVia: 'oauth-token',
        tokenVersion: user.tokenVersion ?? 0,
      });

      return res.json({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      });
    }

    if (grant_type === 'refresh_token') {
      const parsed = RefreshRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
      }
      const { refresh_token, client_id, client_secret, scope } = parsed.data;

      // findByClientId filters isActive, so a deactivated client can no longer refresh. Only relying
      // parties hold these families: a first-party client never reaches a session through here.
      const client = await oauthClientRepository.findByClientId(client_id);
      if (!client) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client' });
      }
      if (client.clientType !== 'relying-party') {
        return res.status(400).json({ error: 'unauthorized_client' });
      }
      if (client.tokenEndpointAuthMethod === 'client_secret_post') {
        const authed = client_secret ? await oauthClientRepository.verifyClientSecret(client_id, client_secret) : null;
        if (!authed) {
          return res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication required' });
        }
      }

      const presented = authSessionService.parseRefreshToken(refresh_token);
      const family = presented ? await oauthRefreshTokenRepository.findByFamilyId(presented.sid) : null;
      // A wrong client_id is rejected WITHOUT revoking, so another client cannot kill this family.
      if (
        !presented ||
        !family ||
        family.revokedAt ||
        family.expiresAt <= new Date() ||
        family.clientId !== client_id
      ) {
        return res.status(400).json(invalidGrant);
      }

      // Strict reuse detection (RFC 9700 2.2.2): a superseded secret on a live family means the chain
      // leaked or was replayed, so the whole family dies, including the holder of the newest token.
      const presentedHash = authSessionService.hashRefreshSecret(presented.secret);
      if (presentedHash !== family.tokenHash) {
        await oauthRefreshTokenRepository.revokeFamily(family.familyId);
        console.warn('[oauth/token] refresh token reuse; family revoked', {
          familyId: family.familyId,
          clientId: client_id,
          userId: family.userId,
        });
        return res.status(400).json(invalidGrant);
      }

      // Every precondition is checked before the rotate below, so a failure here does not consume the token.
      const user = await userRepository.findById(family.userId);
      if (!user || !isTokenVersionCurrent(family.tokenVersion, user.tokenVersion)) {
        return res.status(400).json(invalidGrant);
      }
      try {
        assertAccountStateUsable(user);
      } catch {
        return res.status(400).json(invalidGrant);
      }
      const grant = await oauthGrantRepository.findGrant(user.id, client_id);
      if (!grant || !grantCovers(grant.scopes, family.scopes) || !grant.scopes.includes('offline_access')) {
        return res.status(400).json(invalidGrant);
      }

      const scopes = scope ? scope.split(' ').filter(Boolean) : family.scopes;
      if (!scopes.every(s => family.scopes.includes(s))) {
        return res.status(400).json({ error: 'invalid_scope', error_description: 'scope exceeds the original grant' });
      }

      const nextSecret = authSessionService.generateRefreshSecret();
      const rotated = await oauthRefreshTokenRepository.rotate(family.familyId, {
        expectedHash: presentedHash,
        nextHash: authSessionService.hashRefreshSecret(nextSecret),
        newExpiresAt: refreshFamilyExpiresAt(family.createdAt),
      });
      if (!rotated) {
        // A concurrent request rotated first: the same token was used twice, which is reuse.
        await oauthRefreshTokenRepository.revokeFamily(family.familyId);
        return res.status(400).json(invalidGrant);
      }

      const scopeStr = scopes.join(' ');
      const accessToken = authTokenGenerator.signAccessToken(user.id, user.tokenVersion ?? 0, {
        kind: 'oauth',
        client_id,
        scope: scopeStr,
        aud: oauthAccessTokenAudience(),
      });
      // No nonce on a refreshed id_token (OIDC Core 12.2).
      const idToken = generateIdToken({
        ...idTokenUserParams(user),
        clientId: client_id,
        scopes,
        scopeLimited: true,
      });

      return res.json({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: authSessionService.buildRefreshToken(family.familyId, nextSecret),
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: scopeStr,
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

export const config = { api: { externalResolver: true } };
export default handler;
