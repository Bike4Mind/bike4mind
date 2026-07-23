import { IUserApiKeyRateLimit, IUserApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

/**
 * Per-key request ceilings. Mint-time (create.ts) and the update lever below
 * share one set of bounds so the two can never drift - a key can only ever hold
 * a rate limit that create would also have accepted.
 *
 * Ceilings are sanity guards against fat-finger/overflow values, not product
 * limits. Whole requests only: a fractional ceiling has no meaning to the
 * fixed-window enforcer, which compares integer counters.
 */
export const API_KEY_RATE_LIMIT_MAX_PER_MINUTE = 10_000;
export const API_KEY_RATE_LIMIT_MAX_PER_DAY = 1_000_000;
export const API_KEY_RATE_LIMIT_DEFAULTS: IUserApiKeyRateLimit = {
  requestsPerMinute: 60,
  requestsPerDay: 1000,
};

const requestsPerMinuteSchema = z.number().int().min(1).max(API_KEY_RATE_LIMIT_MAX_PER_MINUTE);
const requestsPerDaySchema = z.number().int().min(1).max(API_KEY_RATE_LIMIT_MAX_PER_DAY);

export const apiKeyRateLimitSchema = z.object({
  requestsPerMinute: requestsPerMinuteSchema.prefault(API_KEY_RATE_LIMIT_DEFAULTS.requestsPerMinute),
  requestsPerDay: requestsPerDaySchema.prefault(API_KEY_RATE_LIMIT_DEFAULTS.requestsPerDay),
});

// Each field optional so one ceiling can be raised without restating the other;
// the unspecified one keeps its stored value. At least one must be present -
// an empty update would silently no-op.
const updateApiKeyRateLimitSchema = z
  .object({
    keyId: z.string().min(1),
    requestsPerMinute: requestsPerMinuteSchema.optional(),
    requestsPerDay: requestsPerDaySchema.optional(),
  })
  .refine(params => params.requestsPerMinute !== undefined || params.requestsPerDay !== undefined, {
    message: 'At least one of requestsPerMinute or requestsPerDay is required',
  });

export type UpdateApiKeyRateLimitParameters = z.infer<typeof updateApiKeyRateLimitSchema>;

interface UpdateApiKeyRateLimitAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

export interface UpdateApiKeyRateLimitResult {
  id: string;
  name: string;
  rateLimit: IUserApiKeyRateLimit;
}

/**
 * Raise or lower an existing key's request ceilings without rotating it.
 * Ownership-scoped via findByUserIdAndId, so a caller can only ever retarget
 * their own key; the admin route resolves the owner first and calls through
 * here so the same bounds apply.
 *
 * Takes effect on the very next request: the enforcer reads the ceilings off
 * the freshly-validated key document (validate.ts -> checkApiKeyRateLimit),
 * and only the counters live in cache. Lowering a ceiling below the current
 * counter therefore wedges the key until its window rolls over - clear it with
 * resetApiKeyRateLimit if that is not wanted.
 */
export const updateApiKeyRateLimit = async (
  userId: string,
  parameters: UpdateApiKeyRateLimitParameters,
  adapters: UpdateApiKeyRateLimitAdapters
): Promise<UpdateApiKeyRateLimitResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, updateApiKeyRateLimitSchema);

  const apiKey = await db.userApiKeys.findByUserIdAndId(userId, params.keyId);
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }

  const rateLimit: IUserApiKeyRateLimit = {
    requestsPerMinute:
      params.requestsPerMinute ?? apiKey.rateLimit?.requestsPerMinute ?? API_KEY_RATE_LIMIT_DEFAULTS.requestsPerMinute,
    requestsPerDay:
      params.requestsPerDay ?? apiKey.rateLimit?.requestsPerDay ?? API_KEY_RATE_LIMIT_DEFAULTS.requestsPerDay,
  };

  await db.userApiKeys.setRateLimit(apiKey.id, rateLimit);

  return { id: apiKey.id, name: apiKey.name, rateLimit };
};
