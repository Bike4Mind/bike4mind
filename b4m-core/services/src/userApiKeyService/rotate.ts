import { IUserApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { KEY_PREFIX_LENGTH } from './constants';

const rotateUserApiKeySchema = z.object({
  keyId: z.string(),
});

export type RotateUserApiKeyParameters = z.infer<typeof rotateUserApiKeySchema>;

interface RotateUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

export interface RotateUserApiKeyResult {
  id: string;
  name: string;
  keyPrefix: string;
  key: string; // Only returned once during rotation
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

export const rotateUserApiKey = async (
  userId: string,
  parameters: RotateUserApiKeyParameters,
  adapters: RotateUserApiKeyAdapters
): Promise<RotateUserApiKeyResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, rotateUserApiKeySchema);

  const apiKey = await db.userApiKeys.findByUserIdAndId(userId, params.keyId);
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }

  const { key, keyPrefix, keyHash } = generateNewApiKey();

  apiKey.keyHash = keyHash;
  apiKey.keyPrefix = keyPrefix;

  await db.userApiKeys.update(apiKey);

  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    key, // This is the only time the raw key is returned
  };
};
