/**
 * B4M OAuth 2.0 / OIDC Authorization Server
 *
 * Provides Authorization Code + PKCE flow so external apps can use
 * "Sign in with B4M" without sharing credentials.
 * Integration guide: docs-site/docs/developers/building-on-b4m.md
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { isUnconfiguredSecret, requireEnv } from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  oauthClientRepository,
  oauthAuthorizationCodeRepository,
  systemSecretRepository,
  IOAuthClientDocument,
} from '@bike4mind/database';
import { decryptStoredSecret, encryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { PKCE_CODE_VERIFIER_RE, PKCE_S256_CHALLENGE_RE } from './pkce';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'oauthServer' } });

// ─── RSA key pair (RS256) ─────────────────────────────────────────────────────
// A stage that sets OAUTH_RSA_PRIVATE_KEY (base64-encoded PEM) signs with it. A stage without one
// (previews, local) generates a key pair once and shares it through the encrypted SystemSecret
// store, so every server instance signs with, and publishes in its JWKS, the same key. A per-instance
// key would make a token verify only when the verifier's JWKS fetch hit the instance that signed it.

/** SystemSecret row holding the generated key. Distinct from the OAUTH_RSA_PRIVATE_KEY env secret. */
export const GENERATED_SIGNING_KEY_SECRET_NAME = 'OAUTH_GENERATED_RSA_PRIVATE_KEY';

type SigningKey = {
  privateKey: string;
  publicKey: string;
  keyId: string;
  /** True for the stopgap key of an instance that could not reach the shared store. */
  instanceLocal: boolean;
};

let sharedKey: SigningKey | null = null;
let sharedKeyLoad: Promise<SigningKey> | null = null;
let instanceFallbackKey: SigningKey | null = null;
let storeRetryAfter = 0;

/** After a failed store load, how long an instance keeps its stopgap key before trying again (ms). */
const STORE_RETRY_BACKOFF_MS = 60_000;

function toSigningKey(privateKeyPem: string, instanceLocal = false): SigningKey {
  const publicKey = crypto
    .createPublicKey(crypto.createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' }) as string;
  // Derive kid from public key fingerprint so Cognito auto-detects key rotation
  const keyId = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  return { privateKey: privateKeyPem, publicKey, keyId, instanceLocal };
}

function generatePrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

/**
 * Reads the stage's generated key, creating it on first use. The `$setOnInsert` upsert makes
 * concurrent cold starts converge on whichever key was stored first.
 */
async function loadOrCreateSharedPrivateKey(): Promise<string> {
  const existing = await systemSecretRepository.findBySecretName(GENERATED_SIGNING_KEY_SECRET_NAME);
  if (existing) return decryptStoredSecret(existing.encryptedValue);

  const encryptedValue = encryptToken(generatePrivateKeyPem());
  if (!encryptedValue) throw new Error('Generated OAuth signing key encrypted to an empty value');
  const stored = await systemSecretRepository.upsertSecret(GENERATED_SIGNING_KEY_SECRET_NAME, {
    encryptedValue,
    category: 'oauth',
    source: 'auto_generated',
    isOverridable: false,
    description: 'Auto-generated OAuth/OIDC ID token signing key, used when OAUTH_RSA_PRIVATE_KEY is not set',
  });
  logger.warn(
    'OAUTH_RSA_PRIVATE_KEY not set - using a generated RSA key pair shared through the database. Set this secret before going to production.'
  );
  return decryptStoredSecret(stored.encryptedValue);
}

function configuredPrivateKey(): string | undefined {
  const envKey = Config.OAUTH_RSA_PRIVATE_KEY;
  return envKey && !isUnconfiguredSecret(envKey) ? Buffer.from(envKey, 'base64').toString('utf8') : undefined;
}

async function getSigningKey(): Promise<SigningKey> {
  if (sharedKey) return sharedKey;

  const envKey = configuredPrivateKey();
  if (envKey) {
    sharedKey = toSigningKey(envKey);
    return sharedKey;
  }

  // A failing store (no encryption key, an undecryptable row) would otherwise cost a key
  // generation and an error log on every OAuth call.
  if (instanceFallbackKey && Date.now() < storeRetryAfter) return instanceFallbackKey;

  // One store round trip per instance, however many requests arrive while it is in flight.
  sharedKeyLoad ??= loadOrCreateSharedPrivateKey()
    .then(privateKey => (sharedKey = toSigningKey(privateKey)))
    .catch((error: unknown) => {
      // Keep signing with an instance-local key rather than fail the request; only a stored key
      // is cached for good, so the store is retried once the backoff passes.
      sharedKeyLoad = null;
      storeRetryAfter = Date.now() + STORE_RETRY_BACKOFF_MS;
      logger.error('Could not load the shared OAuth signing key; using an instance-local key', { error });
      instanceFallbackKey ??= toSigningKey(generatePrivateKeyPem(), true);
      return instanceFallbackKey;
    });
  return sharedKeyLoad;
}

// ─── JWKS ─────────────────────────────────────────────────────────────────────

/**
 * The JWKS to publish, and whether a cache may keep it. An instance-local stopgap key must not be
 * cached, since no other instance signs with it.
 */
export async function getJwks() {
  const { publicKey, keyId, instanceLocal } = await getSigningKey();
  const keyObject = crypto.createPublicKey(publicKey);
  const jwk = keyObject.export({ format: 'jwk' }) as crypto.JsonWebKey;

  const jwks = {
    keys: [
      {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        use: 'sig',
        alg: 'RS256',
        kid: keyId,
      },
    ],
  };
  return { jwks, cacheable: !instanceLocal };
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  // Reject anything outside RFC 7636's grammar before hashing. A low-entropy verifier (e.g. "a") is
  // offline-recoverable from the challenge exposed at authorization, and the challenge must be a
  // 43-char base64url S256 digest. The request schemas enforce this at the boundary too; guarding the
  // predicate keeps it safe for any caller.
  if (!PKCE_CODE_VERIFIER_RE.test(codeVerifier) || !PKCE_S256_CHALLENGE_RE.test(codeChallenge)) {
    return false;
  }
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

/**
 * Which identity claims a token may release, given its scopes and whether it is scope-limited.
 * A relying-party OAuth grant is scope-limited: `email` releases the email claim, `profile` releases
 * name/picture (OIDC Core 5.4). A first-party / legacy token is NOT scope-limited and keeps the full
 * claim set (the pre-scoping behavior). Single source of truth for BOTH the id_token
 * (generateIdToken below) and the userinfo endpoint (pages/api/oauth/userinfo.ts) so the two
 * projections cannot drift apart.
 */
export function releasedIdentityClaims(opts: { scopes: string[]; scopeLimited: boolean }): {
  email: boolean;
  profile: boolean;
} {
  const releaseAll = !opts.scopeLimited;
  return {
    email: releaseAll || opts.scopes.includes('email'),
    profile: releaseAll || opts.scopes.includes('profile'),
  };
}

export async function generateIdToken(params: {
  userId: string;
  email: string;
  name: string;
  picture?: string | null;
  clientId: string;
  scopes: string[];
  // True only for a relying-party OAuth grant; a first-party / legacy caller passes false and gets
  // the full claim set. See releasedIdentityClaims.
  scopeLimited: boolean;
  nonce?: string;
}): Promise<string> {
  const { privateKey, keyId } = await getSigningKey();
  const issuer = requireEnv('APP_URL', process.env.APP_URL);
  const now = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    iss: issuer,
    sub: params.userId,
    aud: params.clientId,
    iat: now,
    exp: now + 3600,
  };

  // OIDC claim gating (OpenID Connect Core 5.4), via the shared decision so id_token and userinfo
  // stay in lockstep: a relying-party grant releases email/name/picture only for the scopes it holds
  // (an openid-only token carries sub but no PII); a first-party token keeps the full set.
  const release = releasedIdentityClaims({ scopes: params.scopes, scopeLimited: params.scopeLimited });
  if (release.email) payload.email = params.email;
  if (release.profile) {
    payload.name = params.name;
    if (params.picture) payload.picture = params.picture;
  }
  if (params.nonce) payload.nonce = params.nonce;

  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    keyid: keyId,
  } as jwt.SignOptions);
}

/**
 * Verifies an `id_token_hint` (OIDC RP-Initiated Logout 1.0, section 2): our own RS256 signature,
 * our issuer and, when the RP sent one, `aud == clientId`. Without a client_id the audience names
 * the client. Expiry is ignored, as the spec allows, since an RP commonly signs out long after its
 * id_token expired. Returns the subject and client, or null for any failure.
 */
export async function verifyIdTokenHint(
  idTokenHint: string,
  clientId?: string
): Promise<{ sub: string; clientId: string } | null> {
  const { publicKey } = await getSigningKey();
  try {
    // Never a string payload: the issuer check rejects one.
    const { sub, aud } = jwt.verify(idTokenHint, publicKey, {
      algorithms: ['RS256'],
      issuer: requireEnv('APP_URL', process.env.APP_URL),
      ...(clientId !== undefined ? { audience: clientId } : {}),
      ignoreExpiration: true,
    }) as jwt.JwtPayload;
    const audience = clientId ?? aud;
    return typeof sub === 'string' && sub && typeof audience === 'string' && audience
      ? { sub, clientId: audience }
      : null;
  } catch {
    return null;
  }
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
    end_session_endpoint: `${issuer}/oauth/logout`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // The token endpoint reads client_secret only from the POST body, and public clients
    // (PKCE, no secret) are supported - so advertise exactly those two, not client_secret_basic.
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'email', 'name', 'picture'],
    code_challenge_methods_supported: ['S256'],
  };
}
