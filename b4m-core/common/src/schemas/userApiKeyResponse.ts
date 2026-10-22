import * as z from 'zod';
import type { IUserApiKeyDocument } from '../types/entities/UserApiKeyTypes';
import { passthroughShape } from './responseShape';

/**
 * Secret fields of an API key, never sent to a client: the legacy bcrypt hash, the SHA-256 digest
 * of the raw key, and the callback signing secret. UserApiKeyModel's toJSON transform also drops
 * them; this keeps them out if a read path skips serialization.
 */
export const USER_API_KEY_WITHHELD_FIELDS = ['keyHash', 'keyDigest', 'callbackSigningSecret'] as const;

// Held to IUserApiKeyDocument: a new field fails the build here until it is classified.
const USER_API_KEY_RESPONSE_FIELDS = {
  id: true,
  userId: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  status: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  revokedBy: true,
  revokedReason: true,
  callbackSigningSecretCreatedAt: true,
  rateLimit: true,
  usage: true,
  metadata: true,
  productId: true,
  productName: true,
  billingOwnerType: true,
  organizationId: true,
  agentId: true,
  allowedOrigins: true,
  identifiedClientIds: true,
  preauthorizedLakeIds: true,
  branding: true,
  spendCap: true,
  ownerHasWhitelabel: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Record<Exclude<keyof IUserApiKeyDocument, (typeof USER_API_KEY_WITHHELD_FIELDS)[number]>, true>;

/** An API key as the admin routes return it: everything but the secret material. */
export const userApiKeyResponseSchema = z.object(passthroughShape(USER_API_KEY_RESPONSE_FIELDS));

const rateLimitUsageResponseSchema = z.object({
  minute: z.number(),
  day: z.number(),
  minuteResetAt: z.number().optional(),
  dayResetAt: z.number().optional(),
});

/** GET /api/admin/users/[userId]/user-api-keys */
export const adminUserApiKeysResponseSchema = z.object({
  apiKeys: z.array(userApiKeyResponseSchema),
  liveUsage: z.record(z.string(), rateLimitUsageResponseSchema),
});
