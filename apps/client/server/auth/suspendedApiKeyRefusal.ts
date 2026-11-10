import { accountSuspendedError } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';

/**
 * Suspension disables every key the account holds, so a suspended owner's key no longer validates.
 * When the presented key is one of those (secret matched), answer with the owner's
 * `account_suspended` 403 instead of a bare "Invalid API key", so the caller learns why and how to
 * appeal. Shared by apiKeyAuth and the CLI key check; mirrors suspendedSessionRefusal on the refresh
 * path. Best-effort: the request is already refused, so a failed lookup keeps the plain 401 rather
 * than turning it into a 5xx.
 */
export async function refuseIfSuspendedOwner(apiKey: string, logger?: { warn(msg: string, meta?: unknown): void }) {
  let owner: { isBanned?: boolean; suspensionReasonCategory?: string | null } | null = null;
  try {
    const ownerId = await userApiKeyService.findOwnerOfDisabledUserApiKey(apiKey, {
      db: { userApiKeys: userApiKeyRepository },
    });
    if (!ownerId) return;
    owner = await User.findById(ownerId).select('isBanned suspensionReasonCategory').lean();
  } catch (error) {
    logger?.warn('Suspended-owner lookup for a refused API key failed', { error: String(error) });
    return;
  }
  if (owner?.isBanned) throw accountSuspendedError(owner.suspensionReasonCategory);
}
