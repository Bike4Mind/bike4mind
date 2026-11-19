import { ApiKeyStatus, MODERATION_EXCEPTION_CATEGORIES, type IUserApiKeyRepository } from '@bike4mind/common';

const EXCEPTABLE: ReadonlySet<string> = new Set(MODERATION_EXCEPTION_CATEGORIES);

/**
 * Whether a key's exception covers a flagged result: every flagged label must be both on the key
 * and on MODERATION_EXCEPTION_CATEGORIES. One label outside either keeps the block, as does a
 * result that names no label at all.
 */
export function moderationExceptionCovers(flagged: readonly string[], keyCategories: readonly string[]): boolean {
  if (flagged.length === 0) return false;
  const covered = new Set(keyCategories.filter(category => EXCEPTABLE.has(category)));
  return flagged.every(category => covered.has(category));
}

export type ModerationExceptionAdapters = {
  userApiKeys: Pick<IUserApiKeyRepository, 'findModerationException'>;
};

/**
 * The exception categories of the key that authenticated a turn. Empty unless the key still
 * exists, is active and unexpired, and belongs to the user the turn runs as.
 */
export async function findKeyModerationExceptionCategories(
  apiKeyId: string,
  userId: string,
  adapters: ModerationExceptionAdapters,
  now: Date = new Date()
): Promise<readonly string[]> {
  const key = await adapters.userApiKeys.findModerationException(apiKeyId);
  if (!key || key.userId !== userId || key.status !== ApiKeyStatus.ACTIVE) return [];
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return [];
  return key.moderationException.categories;
}
