import { IOrganizationRepository, IRealtimeConnectionRepository, IUserApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { resolveOwnedApiKey } from './resolveOwnedApiKey';
import { endRealtimeConnections } from '../authSessionService/endRealtimeConnections';

const revokeUserApiKeySchema = z.object({
  keyId: z.string(),
  reason: z.string().optional(),
});

export type RevokeUserApiKeyParameters = z.infer<typeof revokeUserApiKeySchema>;

interface RevokeUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository & Pick<Required<IUserApiKeyRepository>, 'revokeIfNotDisabled'>;
    organizations: Pick<IOrganizationRepository, 'findIdsAdministeredBy'>;
    // Optional only so existing overlay callers keep compiling; when omitted, the realtime sweep
    // ends the key's connections on its next run instead. In-repo callers always pass it.
    realtimeConnections?: Pick<IRealtimeConnectionRepository, 'endConnections'>;
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

  await db.userApiKeys.revokeIfNotDisabled(apiKey.id, userId, params.reason);
  if (db.realtimeConnections) {
    await endRealtimeConnections({ apiKeyId: apiKey.id }, { db: { realtimeConnections: db.realtimeConnections } });
  }

  return { name: apiKey.name };
};
