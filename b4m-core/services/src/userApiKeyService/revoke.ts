import { ApiKeyStatus, IOrganizationRepository, IUserApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { resolveOwnedApiKey } from './resolveOwnedApiKey';

const revokeUserApiKeySchema = z.object({
  keyId: z.string(),
  reason: z.string().optional(),
});

export type RevokeUserApiKeyParameters = z.infer<typeof revokeUserApiKeySchema>;

interface RevokeUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
    organizations: Pick<IOrganizationRepository, 'findIdsAdministeredBy'>;
  };
}

export interface RevokeUserApiKeyResult {
  /** The revoked key's name, so callers can log a real name instead of a placeholder. */
  name: string;
}

/**
 * Revoke (disable) a key, scoped by resolveOwnedApiKey (the key's minter, or an
 * admin of the org it is billed to). `revokedBy` records the acting caller,
 * which is genuinely distinct from the minter when an org admin revokes a
 * teammate's key.
 */
export const revokeUserApiKey = async (
  userId: string,
  parameters: RevokeUserApiKeyParameters,
  adapters: RevokeUserApiKeyAdapters
): Promise<RevokeUserApiKeyResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, revokeUserApiKeySchema);

  const apiKey = await resolveOwnedApiKey(userId, params.keyId, { db });
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }

  // Stamp only on the actual transition, so re-revoking never resets the audit
  // trail and a key disabled before these fields existed keeps an honest blank.
  if (apiKey.status !== ApiKeyStatus.DISABLED) {
    apiKey.revokedAt = new Date();
    apiKey.revokedBy = userId;
    if (params.reason) {
      apiKey.revokedReason = params.reason;
    }
  }

  apiKey.status = ApiKeyStatus.DISABLED;
  await db.userApiKeys.update(apiKey);

  return { name: apiKey.name };
};
