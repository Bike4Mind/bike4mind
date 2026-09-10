/**
 * POST /api/oauth/token
 *
 * OAuth 2.0 token endpoint. Supports:
 * - grant_type=authorization_code  (PKCE)
 * - grant_type=refresh_token       (existing B4M refresh token)
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { oauthAuthorizationCodeRepository, userRepository } from '@bike4mind/database';
import { verifyPkce, validateClientSecret, validateClient, generateIdToken } from '@server/auth/oauthServer';
import { issueSessionForRequest } from '@server/auth/issueSession';
import { ACCESS_TOKEN_TTL_SECONDS } from '@server/auth/tokenGenerator';

const AuthCodeRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string(),
  redirect_uri: z.string().url(),
  client_id: z.string(),
  // PKCE clients send code_verifier; confidential clients (e.g. Cognito) send client_secret instead
  code_verifier: z.string().optional(),
  client_secret: z.string().optional(),
});

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

      // Atomically claim the code so a leaked code can't be redeemed twice by
      // concurrent requests. Any subsequent failure leaves it consumed (single-use).
      const authCode = await oauthAuthorizationCodeRepository.consumeValidCode(code);
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

      const user = await userRepository.findById(authCode.userId);
      if (!user) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found' });
      }

      const { accessToken, refreshToken } = await issueSessionForRequest(req, user.id, {
        createdVia: 'oauth-token',
        tokenVersion: user.tokenVersion ?? 0,
      });

      const userEmail = user.email ?? '';
      const idToken = generateIdToken({
        userId: user.id,
        email: userEmail,
        name: user.username || userEmail.split('@')[0],
        picture: (user.oauthCredentials as any)?.picture ?? null,
        clientId: client_id,
        scopes: authCode.scopes,
        nonce: authCode.nonce,
      });

      return res.json({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

export const config = { api: { externalResolver: true } };
export default handler;
