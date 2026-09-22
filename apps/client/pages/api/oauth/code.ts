/**
 * POST /api/oauth/code
 *
 * Generates an authorization code for a verified B4M session.
 * Called by the /oauth/authorize React page after the user is confirmed logged in.
 * Requires a valid B4M Bearer JWT (the same token used for all B4M API calls).
 */

import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { oauthGrantRepository } from '@bike4mind/database';
import { generateAuthCode, validateClient } from '@server/auth/oauthServer';
import { decideConsent } from '@server/auth/oauthConsent';

const RequestSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string().url(),
  scope: z.string().default('openid email profile'),
  state: z.string().optional(),
  // PKCE is optional - confidential clients (e.g. Cognito) omit these
  code_challenge: z.string().optional(),
  code_challenge_method: z.literal('S256').optional(),
  nonce: z.string().optional(),
  // The user clicked Allow on the consent screen for this request (relying-party clients only).
  consent: z.boolean().optional(),
  // OIDC prompt: 'consent' forces the screen even when a grant already covers the scopes.
  prompt: z.string().optional(),
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

  const { client_id, redirect_uri, scope, code_challenge, code_challenge_method, nonce, consent, prompt } = parsed.data;

  // Discovery advertises only S256, so a code_challenge without an explicit code_challenge_method=S256
  // is rejected rather than silently treated as S256 (RFC 7636 4.3): the client and server must agree
  // on the method, not have the server assume one.
  if (code_challenge && code_challenge_method !== 'S256') {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'code_challenge_method=S256 is required when code_challenge is present',
    });
  }

  const client = await validateClient(client_id, redirect_uri);
  if (!client) {
    return res
      .status(400)
      .json({ error: 'unauthorized_client', error_description: 'Unknown client or redirect_uri mismatch' });
  }

  // Reject a challenge-less authorization for a public client (RFC 7636 4.4.1)
  // so the token endpoint never has to redeem a downgraded, PKCE-less code.
  const isConfidential = client.tokenEndpointAuthMethod === 'client_secret_post';
  if (!isConfidential && !code_challenge) {
    return res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'code_challenge is required (PKCE) for this client' });
  }

  // Reject any scope the client is not registered for (RFC 6749 4.1.2.1) rather than silently
  // dropping it, so a client that asks for more than it may have gets a clear error instead of a
  // narrower grant it never notices.
  const requestedScopes = scope.split(' ').filter(Boolean);
  const disallowedScopes = requestedScopes.filter(s => !client.allowedScopes.includes(s));
  if (disallowedScopes.length > 0) {
    return res
      .status(400)
      .json({ error: 'invalid_scope', error_description: `Unsupported scope(s): ${disallowedScopes.join(' ')}` });
  }

  // Consent gate (relying-party clients only; first-party clients keep the silent auto-redirect).
  // No code is minted until a grant covering the requested scopes exists. A remembered grant skips
  // the prompt; new or escalated scopes re-prompt (OIDC Core 3.1.2.4).
  if (client.clientType === 'relying-party') {
    const grant = await oauthGrantRepository.findGrant(user.id, client_id);
    const decision = decideConsent({
      isRelyingParty: true,
      requestedScopes,
      grantedScopes: grant?.scopes ?? null,
      consentGiven: consent === true,
      // `prompt` is a space-delimited set (OIDC Core 3.1.2.1), so e.g. `prompt=login consent` must
      // still force consent - a bare `=== 'consent'` would skip it.
      forceConsent: (prompt?.split(/\s+/).filter(Boolean) ?? []).includes('consent'),
    });

    if (decision === 'consent_required') {
      // Interactive signal to the authorize page: render the Allow/Deny screen. No code minted.
      return res.json({ consent_required: true, client_name: client.name, scopes: requestedScopes });
    }

    if (consent === true) {
      // Persist the decision. upsertGrant widens atomically ($addToSet), so a re-consent for a subset
      // never drops previously approved scopes and two concurrent tabs can't lose-update each other -
      // hence we hand it the requested scopes, not a caller-computed union.
      await oauthGrantRepository.upsertGrant({
        userId: user.id,
        clientId: client_id,
        scopes: requestedScopes,
        source: 'authorize',
      });
    }
  }

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
