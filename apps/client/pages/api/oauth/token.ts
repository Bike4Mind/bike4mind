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
import { authTokenGenerator } from '@server/auth/tokenGenerator';

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

      let client;
      if (client_secret) {
        client = await validateClientSecret(client_id, client_secret, redirect_uri);
      } else {
        client = await validateClient(client_id, redirect_uri);
      }

      if (!client) {
        return res
          .status(401)
          .json({ error: 'unauthorized_client', error_description: 'Invalid client credentials or redirect_uri' });
      }

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

      // Verify PKCE (only when a code_challenge was stored during authorization)
      if (authCode.codeChallenge) {
        if (!code_verifier || !verifyPkce(code_verifier, authCode.codeChallenge)) {
          return res
            .status(400)
            .json({ error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' });
        }
      }

      // prevent replay
      await oauthAuthorizationCodeRepository.markUsed(authCode.id);

      const user = await userRepository.findById(authCode.userId);
      if (!user) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'User not found' });
      }

      const { accessToken, refreshToken } = authTokenGenerator.createAccessToken(user.id, user.tokenVersion ?? 0);

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
        expires_in: 3600,
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

export const config = { api: { externalResolver: true } };
export default handler;
