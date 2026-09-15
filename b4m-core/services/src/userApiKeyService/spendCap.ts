import { ApiKeyScope, IUserApiKeyRepository } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { EMBED_SPEND_CAP_MAX_CREDITS } from './create';

/**
 * Operational levers for a capped embed key, pending the admin-UI surface:
 * raise/lower/clear the cap (setEmbedKeySpendCap) or zero the accumulated
 * meter (resetEmbedKeySpend) - either lets an over-cap key resume traffic on
 * its next request, since the pre-flight gate reads the live document.
 */

const setEmbedKeySpendCapSchema = z.object({
  keyId: z.string().min(1),
  // Same bounds as mint-time validation; null clears the cap (uncapped).
  spendCap: z.number().int().positive().max(EMBED_SPEND_CAP_MAX_CREDITS).nullable(),
});

export type SetEmbedKeySpendCapParameters = z.infer<typeof setEmbedKeySpendCapSchema>;

const resetEmbedKeySpendSchema = z.object({
  keyId: z.string().min(1),
});

export type ResetEmbedKeySpendParameters = z.infer<typeof resetEmbedKeySpendSchema>;

interface SpendCapAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

/** Ownership + embed-scope gate shared by both levers. */
async function loadOwnedEmbedKey(userId: string, keyId: string, db: SpendCapAdapters['db']) {
  const apiKey = await db.userApiKeys.findByUserIdAndId(userId, keyId);
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }
  if (!apiKey.scopes.includes(ApiKeyScope.EMBED_CHAT)) {
    throw new BadRequestError('spendCap requires the embed:chat scope');
  }
  return apiKey;
}

export const setEmbedKeySpendCap = async (
  userId: string,
  parameters: SetEmbedKeySpendCapParameters,
  adapters: SpendCapAdapters
): Promise<{ id: string; spendCap?: number }> => {
  const { db } = adapters;
  const params = secureParameters(parameters, setEmbedKeySpendCapSchema);

  const apiKey = await loadOwnedEmbedKey(userId, params.keyId, db);
  await db.userApiKeys.setSpendCap(apiKey.id, params.spendCap);

  return { id: apiKey.id, spendCap: params.spendCap ?? undefined };
};

export const resetEmbedKeySpend = async (
  userId: string,
  parameters: ResetEmbedKeySpendParameters,
  adapters: SpendCapAdapters
): Promise<{ id: string }> => {
  const { db } = adapters;
  const params = secureParameters(parameters, resetEmbedKeySpendSchema);

  const apiKey = await loadOwnedEmbedKey(userId, params.keyId, db);
  await db.userApiKeys.resetSpend(apiKey.id);

  return { id: apiKey.id };
};
