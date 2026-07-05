/**
 * B4M OAuth 2.0 / OIDC Authorization Server
 *
 * Provides Authorization Code + PKCE flow so external products
 * (VibesWire, VibesTrader, NapkinBizPlan, PotionQuest, EBDC) can use
 * "Sign in with B4M" without sharing credentials.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { requireEnv } from '@bike4mind/common';
import { Config } from '@server/utils/config';
import { oauthClientRepository, oauthAuthorizationCodeRepository, IOAuthClientDocument } from '@bike4mind/database';

// ─── RSA key pair (RS256) ─────────────────────────────────────────────────────
// In production set OAUTH_RSA_PRIVATE_KEY=<base64-encoded PEM private key>
// In development an ephemeral key pair is generated automatically.

let _privateKey: string | null = null;
let _publicKey: string | null = null;
let _keyId: string | null = null;

function getKeyPair(): { privateKey: string; publicKey: string } {
  if (_privateKey && _publicKey) return { privateKey: _privateKey, publicKey: _publicKey };

  const envKey =
    Config.OAUTH_RSA_PRIVATE_KEY && Config.OAUTH_RSA_PRIVATE_KEY !== 'not-configured'
      ? Config.OAUTH_RSA_PRIVATE_KEY
      : undefined;

  if (envKey) {
    _privateKey = Buffer.from(envKey, 'base64').toString('utf8');
    const keyObject = crypto.createPrivateKey(_privateKey);
    _publicKey = crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'pem' }) as string;
  } else {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    _privateKey = privateKey;
    _publicKey = publicKey;
    console.warn(
      '[OAuthServer] OAUTH_RSA_PRIVATE_KEY not set — generated ephemeral RSA key pair. Set this secret before going to production.'
    );
  }

  // Derive kid from public key fingerprint so Cognito auto-detects key rotation
  _keyId = crypto.createHash('sha256').update(_publicKey!).digest('hex').slice(0, 16);

  return { privateKey: _privateKey!, publicKey: _publicKey! };
}

// ─── JWKS ─────────────────────────────────────────────────────────────────────

export function getJwks() {
  const { publicKey } = getKeyPair();
  const keyObject = crypto.createPublicKey(publicKey);
  const jwk = keyObject.export({ format: 'jwk' }) as crypto.JsonWebKey;

  return {
    keys: [
      {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        use: 'sig',
        alg: 'RS256',
        kid: _keyId!,
      },
    ],
  };
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

// ─── Auth code generation ─────────────────────────────────────────────────────

export async function generateAuthCode(params: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge?: string;
  nonce?: string;
}): Promise<string> {
  const code = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await oauthAuthorizationCodeRepository.create({
    code,
    clientId: params.clientId,
    userId: params.userId,
    redirectUri: params.redirectUri,
    scopes: params.scopes,
    codeChallenge: params.codeChallenge ?? '',
    codeChallengeMethod: params.codeChallenge ? 'S256' : undefined,
    nonce: params.nonce,
    expiresAt,
    used: false,
  });

  return code;
}

// ─── Token generation ─────────────────────────────────────────────────────────

export interface OAuthTokens {
  access_token: string;
  id_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export function generateIdToken(params: {
  userId: string;
  email: string;
  name: string;
  picture?: string | null;
  clientId: string;
  scopes: string[];
  nonce?: string;
}): string {
  const { privateKey } = getKeyPair();
  const issuer = requireEnv('APP_URL', process.env.APP_URL);
  const now = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    iss: issuer,
    sub: params.userId,
    aud: params.clientId,
    iat: now,
    exp: now + 3600,
    email: params.email,
    name: params.name,
  };

  if (params.picture) payload.picture = params.picture;
  if (params.nonce) payload.nonce = params.nonce;

  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    keyid: _keyId!,
  } as jwt.SignOptions);
}

// ─── Client validation ────────────────────────────────────────────────────────

export async function validateClient(clientId: string, redirectUri: string): Promise<IOAuthClientDocument | null> {
  const client = await oauthClientRepository.findByClientId(clientId);
  if (!client) return null;
  if (!client.redirectUris.includes(redirectUri)) return null;
  return client;
}

export async function validateClientSecret(
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<IOAuthClientDocument | null> {
  const client = await oauthClientRepository.verifyClientSecret(clientId, clientSecret);
  if (!client) return null;
  if (!client.redirectUris.includes(redirectUri)) return null;
  return client;
}

// ─── OIDC discovery document ──────────────────────────────────────────────────

export function getOidcDiscovery() {
  const issuer = requireEnv('APP_URL', process.env.APP_URL);

  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    userinfo_endpoint: `${issuer}/api/oauth/userinfo`,
    jwks_uri: `${issuer}/api/oauth/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'email', 'name', 'picture'],
    code_challenge_methods_supported: ['S256'],
  };
}
