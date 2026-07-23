import { ApiKeyStatus, IUserApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const revokeUserApiKeySchema = z.object({
  keyId: z.string(),
  reason: z.string().optional(),
});

export type RevokeUserApiKeyParameters = z.infer<typeof revokeUserApiKeySchema>;

interface RevokeUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

export interface RevokeUserApiKeyResult {
  /** The revoked key's name, so callers can log a real name instead of a placeholder. */
  name: string;
}

export const revokeUserApiKey = async (
  userId: string,
  parameters: RevokeUserApiKeyParameters,
  adapters: RevokeUserApiKeyAdapters
): Promise<RevokeUserApiKeyResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, revokeUserApiKeySchema);

  const apiKey = await db.userApiKeys.findByUserIdAndId(userId, params.keyId);
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
