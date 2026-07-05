/**
 * POST /api/oauth/code
 *
 * Generates an authorization code for a verified B4M session.
 * Called by the /oauth/authorize React page after the user is confirmed logged in.
 * Requires a valid B4M Bearer JWT (the same token used for all B4M API calls).
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { generateAuthCode, validateClient } from '@server/auth/oauthServer';

const RequestSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string().url(),
  scope: z.string().default('openid email profile'),
  state: z.string().optional(),
  // PKCE is optional - confidential clients (e.g. Cognito) omit these
  code_challenge: z.string().optional(),
  code_challenge_method: z.literal('S256').optional(),
  nonce: z.string().optional(),
});

const handler = baseApi({ auth: true }).post(async (req, res) => {
  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
  }

  const { client_id, redirect_uri, scope, code_challenge, nonce } = parsed.data;

  const client = await validateClient(client_id, redirect_uri);
  if (!client) {
    return res
      .status(400)
      .json({ error: 'unauthorized_client', error_description: 'Unknown client or redirect_uri mismatch' });
  }

  const requestedScopes = scope.split(' ').filter(s => client.allowedScopes.includes(s));

  const code = await generateAuthCode({
    clientId: client_id,
    userId: user.id,
    redirectUri: redirect_uri,
    scopes: requestedScopes,
    codeChallenge: code_challenge,
    nonce,
  });

  return res.json({ code });
});

export const config = { api: { externalResolver: true } };
export default handler;
