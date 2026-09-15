/**
 * Verify an *external* AWS Cognito ID token for a Pattern-A federated client.
 *
 * B4M is the OIDC *provider* everywhere else in this codebase (see oauthServer.ts) -
 * it issues and verifies its own RS256 tokens. This is the one place B4M acts as a
 * *relying party*: a federated app's Cognito pool has already authenticated the user
 * (with B4M as its upstream IdP), and hands us the resulting Cognito ID token so we
 * can mint that user a scoped AI key. We must therefore verify the token against the
 * *client's* Cognito JWKS, not B4M's.
 *
 * Uses `aws-jwt-verify` (AWS-official, zero runtime deps): it fetches and caches the
 * pool JWKS, follows kid rotation, verifies the RS256 signature, and asserts
 * `iss`/`aud`/`exp`/`iat`. We add the `token_use === 'id'` assertion (the generic
 * verifier doesn't) and pull B4M's `sub` out of the Cognito `identities[]` claim.
 */

import { JwtVerifier } from 'aws-jwt-verify';
import type { IOAuthClientFederatedIdp } from '@bike4mind/database/auth';

/** Thrown for any verification/extraction failure. The route maps this to `invalid_grant`. */
export class CognitoIdTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CognitoIdTokenError';
  }
}

/**
 * One verifier instance per distinct trust config. `aws-jwt-verify` holds the JWKS
 * cache *inside* the verifier, so reusing the instance across requests is what keeps
 * us from fetching the pool JWKS on every exchange. Keyed on the fields that change
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

export interface VerifiedCognitoIdentity {
  /** B4M user id carried by the matching `identities[]` entry's `userId`. */
  b4mUserId: string;
  /** The verified token claims (for logging/diagnostics). */
  claims: Record<string, unknown>;
}

/**
 * Verify a Cognito ID token against the client's federated trust config and resolve
 * the B4M user id it represents. Throws {@link CognitoIdTokenError} on any failure -
 * bad signature, wrong issuer/audience, expired, non-`id` token_use, or no matching
 * B4M identity.
 */
export async function verifyCognitoIdToken(
  idToken: string,
  idp: IOAuthClientFederatedIdp
): Promise<VerifiedCognitoIdentity> {
  let claims: Record<string, unknown>;
  try {
    claims = (await getVerifier(idp).verify(idToken)) as Record<string, unknown>;
  } catch (cause) {
    throw new CognitoIdTokenError('Cognito ID token failed signature/claim verification', { cause });
  }

  if (claims.token_use !== 'id') {
    throw new CognitoIdTokenError(`Expected an ID token (token_use='id'), got token_use='${String(claims.token_use)}'`);
  }

  const b4mUserId = extractB4mUserId(claims, idp.providerName);
  if (!b4mUserId) {
    throw new CognitoIdTokenError(`No '${idp.providerName}' identity with a userId found in the token`);
  }

  return { b4mUserId, claims };
}

/** Test-only: drop cached verifiers so a test can re-stub `JwtVerifier.create`. */
export function __clearVerifierCache(): void {
  verifierCache.clear();
}
