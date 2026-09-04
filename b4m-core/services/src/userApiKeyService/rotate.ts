import { IOrganizationRepository, IUserApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { KEY_PREFIX_LENGTH } from './constants';
import { resolveOwnedApiKey } from './resolveOwnedApiKey';

const rotateUserApiKeySchema = z.object({
  keyId: z.string(),
});

export type RotateUserApiKeyParameters = z.infer<typeof rotateUserApiKeySchema>;

interface RotateUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
    organizations: Pick<IOrganizationRepository, 'findIdsAdministeredBy'>;
  };
}

export interface RotateUserApiKeyResult {
  id: string;
  name: string;
  keyPrefix: string;
  key: string; // Only returned once during rotation
  /** Set only when rotation re-owned the key; the user it belonged to before. */
  previousOwnerUserId?: string;
}

/**
 * Generate a new secure API key maintaining the same prefix format
 */
function generateNewApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const randomPart = randomBytes(16).toString('hex'); // 32 chars
  const key = `b4m_live_${randomPart}`;
  const keyPrefix = key.substring(0, KEY_PREFIX_LENGTH);
  const keyHash = bcrypt.hashSync(key, 12);

  return { key, keyPrefix, keyHash };
}

/**
 * Rotate a key's secret, scoped by resolveOwnedApiKey (the key's minter, or an
 * admin of the org it is billed to).
 *
 * Rotation RE-OWNS the key to whoever rotated it. Previously only `keyHash` and
 * `keyPrefix` were rewritten, never `userId` - so an org admin rotating a
 * teammate's org-billed key walked away with a plaintext credential that
 * authenticated as that teammate. Re-owning keeps the org-admin capability (the
 * rotate-a-teammate's-org-key flow) while making the returned credential act as
 * the person actually holding it. Billing is untouched: an org-billed key still
 * bills the org, which is what `billingOwnerType`/`organizationId` govern.
 *
 * Callers should surface `previousOwnerUserId` so the original minter can be told
 * their key changed hands.
 */
export const rotateUserApiKey = async (
  userId: string,
  parameters: RotateUserApiKeyParameters,
  adapters: RotateUserApiKeyAdapters
): Promise<RotateUserApiKeyResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, rotateUserApiKeySchema);

  const apiKey = await resolveOwnedApiKey(userId, params.keyId, { db });
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }

  const { key, keyPrefix, keyHash } = generateNewApiKey();

  const previousOwnerUserId = apiKey.userId?.toString();
  const reOwned = !!previousOwnerUserId && previousOwnerUserId !== userId;

  apiKey.keyHash = keyHash;
  apiKey.keyPrefix = keyPrefix;
  if (reOwned) {
    apiKey.userId = userId;
  }

  await db.userApiKeys.update(apiKey);

  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    key, // This is the only time the raw key is returned
    ...(reOwned ? { previousOwnerUserId } : {}),
  };
};
