import {
  ApiKeyStatus,
  ConflictError,
  IOrganizationRepository,
  IUserApiKeyRepository,
  NotFoundError,
} from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { resolveOwnedApiKey } from './resolveOwnedApiKey';

const deleteUserApiKeySchema = z.object({
  keyId: z.string(),
});

export type DeleteUserApiKeyParameters = z.infer<typeof deleteUserApiKeySchema>;

interface DeleteUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
    organizations: Pick<IOrganizationRepository, 'findIdsAdministeredBy'>;
  };
}

export interface DeleteUserApiKeyResult {
  /** The deleted key's name, so callers can log a real name instead of a placeholder. */
  name: string;
}

/**
 * Remove a revoked key's record, scoped by resolveOwnedApiKey (the key's minter,
 * or an admin of the org it is billed to). This is list hygiene, never a
 * security control: only a key already DISABLED may go, so revocation - the
 * write that actually kills the credential and stamps revokedAt (and revokedBy
 * where there is a human actor) - has always happened first. An active key gets
 * a 409, so there is no path to drop a live credential without leaving that
 * trail.
 *
 * `db.userApiKeys.delete` is a soft delete (UserApiKeySchema carries
 * softDeletePlugin): the document stays in the collection with its audit fields
 * but every finder excludes it, so the key leaves the user's list and can never
 * validate again. Historical usage rows keep the raw key id and so lose their
 * name in the usage dashboard ('Unknown key'); the analytics DELETED event and
 * the soft-deleted document are what an operator reads instead.
 */
export const deleteUserApiKey = async (
  userId: string,
  parameters: DeleteUserApiKeyParameters,
  adapters: DeleteUserApiKeyAdapters
): Promise<DeleteUserApiKeyResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, deleteUserApiKeySchema);

  const apiKey = await resolveOwnedApiKey(userId, params.keyId, { db });
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }

  if (apiKey.status !== ApiKeyStatus.DISABLED) {
    throw new ConflictError('Revoke this API key before deleting it');
  }

  await db.userApiKeys.delete(apiKey.id);

  return { name: apiKey.name };
};
