import { ApiKeyScope, BadRequestError, type ApiKeyScopeValue } from '@bike4mind/common';
import { providerEndUserMappingRepository } from '@bike4mind/database';
import { platformEndUserKey, toProviderEndUserId } from '@bike4mind/llm-adapters';

export const END_USER_ID_REQUIRES_SCOPE_MESSAGE = `end_user_id is accepted only from an API key with the ${ApiKeyScope.AI_END_USER_ATTRIBUTION} scope`;

export interface PlatformEndUser {
  ownerUserId: string;
  endUserId: string;
  /** Raw id handed to the LLM adapters as `endUserId`; they hash it into the provider identifier. */
  attributionId: string;
}

/**
 * Authorizes a request's `end_user_id` (already format-checked by PlatformEndUserIdSchema).
 * Returns undefined when none was sent; throws a 400 unless the caller is an API key holding
 * `ai:end-user-attribution`. `apiKey.ownerUserId` is the key's `userId`.
 */
export function resolvePlatformEndUser(
  endUserId: string | undefined,
  apiKey: { ownerUserId: string; scopes: readonly ApiKeyScopeValue[] } | undefined
): PlatformEndUser | undefined {
  if (endUserId === undefined) return undefined;
  if (!apiKey || !apiKey.scopes.includes(ApiKeyScope.AI_END_USER_ATTRIBUTION)) {
    throw new BadRequestError(END_USER_ID_REQUIRES_SCOPE_MESSAGE);
  }
  return {
    ownerUserId: apiKey.ownerUserId,
    endUserId,
    attributionId: platformEndUserKey(apiKey.ownerUserId, endUserId),
  };
}

/**
 * Records the digest -> (owner, end user) mapping the admin provider-id lookup resolves. Not awaited
 * by callers: a failed write is logged and never fails or delays the request.
 */
export function recordPlatformEndUser(
  endUser: PlatformEndUser,
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void }
): void {
  const providerEndUserId = toProviderEndUserId(endUser.attributionId);
  if (!providerEndUserId) return;
  providerEndUserMappingRepository
    .recordSeen({ providerEndUserId, ownerUserId: endUser.ownerUserId, endUserId: endUser.endUserId })
    .catch((error: unknown) => {
      logger.warn('Failed to record provider end-user mapping', {
        ownerUserId: endUser.ownerUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
