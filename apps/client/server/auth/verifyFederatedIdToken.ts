/**
 * Verify the ID token a Pattern-A federated client presents at the AI-token exchange.
 *
 * Two issuer shapes are supported, discriminated by the trust config's `issuer`:
 *
 * - **External IdP** (an AWS Cognito pool that federates B4M upstream). B4M acts as a
 *   *relying party* here - the only place in this codebase it does. The pool has already
 *   authenticated the user, so we verify against the *pool's* JWKS, assert
 *   `token_use === 'id'` (Cognito-specific; the generic verifier doesn't), and pull B4M's
 *   `sub` out of the Cognito `identities[]` claim.
 * - **B4M itself** (`iss` equals B4M's own OIDC issuer, i.e. APP_URL - see
 *   `getOidcDiscovery` in oauthServer.ts). An app that signs users in directly against
 *   B4M holds a token B4M signed, so the user id is plain `sub`, there is no `identities`
 *   claim, and there is no `token_use`. The JWKS URI must be configured explicitly rather
 *   than derived, because B4M's canonical endpoint is `/api/oauth/jwks`.
 *
 * Both shapes run through `aws-jwt-verify` (AWS-official, zero runtime deps): it fetches
 * and caches the JWKS, follows kid rotation, verifies the RS256 signature, and asserts
 * `iss`/`aud`/`exp`/`iat`. Signature verification is also what rejects a B4M *access*
 * token presented as an ID token - those are HS256 session JWTs with no JWKS key.
 */

import { JwtVerifier } from 'aws-jwt-verify';
import type { IOAuthClientFederatedIdp } from '@bike4mind/database/auth';

/** Thrown for any verification/extraction failure. The route maps this to `invalid_grant`. */
export class FederatedIdTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FederatedIdTokenError';
  }
}

/** Trailing slashes are not significant when comparing issuers. */
function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * A token is B4M-issued when its configured `iss` is B4M's own OIDC issuer. Deriving this
 * from APP_URL rather than a config flag means a client cannot opt a foreign issuer into
 * the B4M claim shape (which reads `sub` directly and skips `token_use`).
 *
 * Read without `requireEnv` on purpose: an unset APP_URL must not turn a working external
 * verification into a throw. It fails closed instead - a B4M-issuer client on such a
 * deployment falls into the external branch and is rejected for a missing `token_use`.
 */
function isB4mIssuer(issuer: string): boolean {
  const appUrl = process.env.APP_URL;
  return !!appUrl && normalizeIssuer(issuer) === normalizeIssuer(appUrl);
}

/**
 * One verifier instance per distinct trust config. `aws-jwt-verify` holds the JWKS
 * cache *inside* the verifier, so reusing the instance across requests is what keeps
 * us from fetching the JWKS on every exchange. Keyed on the fields that change
 * the JWKS/claim expectations; `providerName` is not part of the key because it only
 * affects post-verify extraction, not the verifier itself.
 */
function verifierCacheKey(idp: IOAuthClientFederatedIdp): string {
  return `${idp.issuer}|${idp.audience}|${idp.jwksUri ?? ''}`;
}

function createVerifier(idp: IOAuthClientFederatedIdp) {
  // When jwksUri is omitted the verifier derives `${issuer}/.well-known/jwks.json`,
  // which is exactly Cognito's JWKS endpoint - so it's optional for Cognito pools.
  return JwtVerifier.create({
    issuer: idp.issuer,
    audience: idp.audience,
    ...(idp.jwksUri ? { jwksUri: idp.jwksUri } : {}),
  });
}

const verifierCache = new Map<string, ReturnType<typeof createVerifier>>();

function getVerifier(idp: IOAuthClientFederatedIdp) {
  const key = verifierCacheKey(idp);
  let verifier = verifierCache.get(key);
  if (!verifier) {
    verifier = createVerifier(idp);
    verifierCache.set(key, verifier);
  }
  return verifier;
}

/**
 * Cognito puts each linked upstream identity in an `identities` claim. Depending on
 * the pool/token it arrives as a JSON array of objects OR a JSON-encoded string of
 * that array - handle both. Return the `userId` (the upstream `sub`, which for the
 * B4M provider equals `user.id`) of the entry whose `providerName` matches the
 * client's configured B4M provider.
 */
function extractB4mUserId(payload: Record<string, unknown>, providerName: string): string | undefined {
  let identities: unknown = payload.identities;
  if (typeof identities === 'string') {
    try {
      identities = JSON.parse(identities);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(identities)) return undefined;

  const match = identities.find(
    (entry): entry is { userId?: unknown; providerName?: unknown } =>
      !!entry && typeof entry === 'object' && (entry as { providerName?: unknown }).providerName === providerName
  );

  const userId = match?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : undefined;
}

export interface VerifiedFederatedIdentity {
  /** B4M user id: `sub` for a B4M-issued token, the matching `identities[]` entry otherwise. */
  b4mUserId: string;
  /** The verified token claims (for logging/diagnostics). */
  claims: Record<string, unknown>;
}

/**
 * Verify an ID token against the client's federated trust config and resolve the B4M
 * user id it represents. Throws {@link FederatedIdTokenError} on any failure - bad
 * signature, wrong issuer/audience, expired, non-`id` token_use (external shape), a
 * B4M-issuer config without an explicit jwksUri, or no resolvable B4M user id.
 */
export async function verifyFederatedIdToken(
  idToken: string,
  idp: IOAuthClientFederatedIdp
): Promise<VerifiedFederatedIdentity> {
  const b4mIssued = isB4mIssuer(idp.issuer);

  if (b4mIssued && !idp.jwksUri) {
    throw new FederatedIdTokenError('A B4M-issued trust config must set jwksUri explicitly');
  }

  let claims: Record<string, unknown>;
  try {
    claims = (await getVerifier(idp).verify(idToken)) as Record<string, unknown>;
  } catch (cause) {
    throw new FederatedIdTokenError('ID token failed signature/claim verification', { cause });
  }

  if (b4mIssued) {
    const sub = claims.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new FederatedIdTokenError('B4M-issued token has no usable sub claim');
    }
    return { b4mUserId: sub, claims };
  }

  if (claims.token_use !== 'id') {
    throw new FederatedIdTokenError(
      `Expected an ID token (token_use='id'), got token_use='${String(claims.token_use)}'`
    );
  }

  if (!idp.providerName) {
    throw new FederatedIdTokenError('External federated trust config is missing providerName');
  }

  const b4mUserId = extractB4mUserId(claims, idp.providerName);
  if (!b4mUserId) {
    throw new FederatedIdTokenError(`No '${idp.providerName}' identity with a userId found in the token`);
  }

  return { b4mUserId, claims };
}

/** Test-only: drop cached verifiers so a test can re-stub `JwtVerifier.create`. */
export function __clearVerifierCache(): void {
  verifierCache.clear();
}
