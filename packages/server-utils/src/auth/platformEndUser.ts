import {
  ApiKeyScope,
  BadRequestError,
  END_USER_ID_NOT_ALLOWED_ERROR_CODE,
  END_USER_ID_NOT_ALLOWED_MESSAGE,
  INVALID_END_USER_ID_ERROR_CODE,
  INVALID_END_USER_ID_MESSAGE,
  isValidEndUserId,
} from '@bike4mind/common';
import { platformEndUserRepository, type RecordPlatformEndUserInput } from '@bike4mind/database';
import { toPlatformEndUserProviderId } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

export interface PlatformEndUser {
  /** Sent to the model provider in place of the key owner's own identifier. */
  providerEndUserId: string;
  record: RecordPlatformEndUserInput;
}

/**
 * The provider identity for a request's `end_user_id`, or undefined when none was sent. `userId` is
 * the key's owner, the account the request runs as. Only an API
 * key holding `ai:end-user-id` may send one: any other credential, a session included, is refused
 * with a 400 rather than having the value silently dropped. A malformed value is a 400 for every caller.
 */
export function resolvePlatformEndUser(
  endUserId: string | undefined,
  caller: { userId: string | undefined; apiKeyInfo: { keyId: string; scopes: readonly string[] } | undefined }
): PlatformEndUser | undefined {
  if (endUserId === undefined) return undefined;
  if (!isValidEndUserId(endUserId)) {
    throw new BadRequestError(INVALID_END_USER_ID_MESSAGE, { errorCode: INVALID_END_USER_ID_ERROR_CODE });
  }
  const { userId, apiKeyInfo } = caller;
  if (!userId || !apiKeyInfo?.scopes.includes(ApiKeyScope.AI_END_USER_ID)) {
    throw new BadRequestError(END_USER_ID_NOT_ALLOWED_MESSAGE, { errorCode: END_USER_ID_NOT_ALLOWED_ERROR_CODE });
  }
  const providerEndUserId = toPlatformEndUserProviderId(userId, endUserId);
  return {
    providerEndUserId,
    record: { providerEndUserId, keyOwnerId: userId, apiKeyId: apiKeyInfo.keyId, endUserId },
  };
}

/** Persist the lookup row without holding up the request: a failed write is logged, never thrown. */
export function recordPlatformEndUserSeen(endUser: PlatformEndUser, logger: Pick<Logger, 'warn'>): Promise<void> {
  return platformEndUserRepository.recordSeen(endUser.record).catch(error => {
    logger.warn('[platformEndUser] Failed to record end user', {
      apiKeyId: endUser.record.apiKeyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
