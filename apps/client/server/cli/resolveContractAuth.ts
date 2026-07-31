import type { EndpointContract } from '@bike4mind/common';
import { verifyApiKey, verifyJwtToken, type ApiKeyInfo, type VerifiedUser } from './auth';

export type ContractAuthResult =
  { method: 'apiKey'; userId: string; apiKeyInfo: ApiKeyInfo } | { method: 'jwt'; userId: string; user: VerifiedUser };

/**
 * Authenticate a request per the contract's `auth` mode, reusing the shared
 * verifyApiKey / verifyJwtToken primitives so every gate (mfaPending, tokenVersion,
 * policy acceptance, scope check) stays identical to the hand-rolled paths.
 *
 * Authentication ONLY - rate limiting is left to the caller, because its policy
 * (per-key vs per-user, window, source) is endpoint-specific and not modelled on
 * the contract. The api-key-first order matches the existing v1 handlers; a valid
 * key that is later rate-limited is surfaced by the caller (not fallen through to
 * JWT), because this returns the apiKey result before any rate-limit check runs.
 *
 * @throws when the request cannot be authenticated per the contract's auth mode.
 */
export async function resolveContractAuth(
  headers: Record<string, string | undefined>,
  contract: EndpointContract
): Promise<ContractAuthResult> {
  const bearer = headers.authorization?.replace('Bearer ', '');

  if (contract.auth === 'jwtOnly') {
    const user = await verifyJwtToken(bearer);
    return { method: 'jwt', userId: user.id, user };
  }

  if (contract.auth === 'apiKeyOrJwt') {
    try {
      const apiKeyInfo = await verifyApiKey(headers);
      return { method: 'apiKey', userId: apiKeyInfo.userId, apiKeyInfo };
    } catch {
      // No valid API key - fall through to JWT (a valid-but-rate-limited key never
      // reaches here; verifyApiKey does not rate-limit, so success returns above).
      const user = await verifyJwtToken(bearer);
      return { method: 'jwt', userId: user.id, user };
    }
  }

  // `public` (or any future mode) has no auth to resolve.
  throw new Error(`resolveContractAuth: unsupported auth mode "${contract.auth}"`);
}
