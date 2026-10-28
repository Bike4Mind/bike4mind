import * as z from 'zod';
import type { IUserApiKeyDocument } from '../types/entities/UserApiKeyTypes';
import { passthroughShape } from './responseShape';
import { adminApiKeyAccessSchema, adminApiKeyRequestCountsSchema } from './adminUserCredits';

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
  revokedBatchId: true,
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

/**
 * A key's live minute/day rate-limit counters. The single source for the server's
 * `RateLimitUsage` and the admin client's response type, so a new field cannot be stripped here
 * while the producer and the UI both expect it.
 */
export const apiKeyRateLimitUsageSchema = z.object({
  minute: z.number(),
  day: z.number(),
  /** Epoch seconds when the current minute window ends; undefined when no window is open (count 0). */
  minuteResetAt: z.number().optional(),
  /** Epoch seconds when the current day window ends; undefined when no window is open (count 0). */
  dayResetAt: z.number().optional(),
});

export type ApiKeyRateLimitUsage = z.infer<typeof apiKeyRateLimitUsageSchema>;

/** GET /api/admin/users/[userId]/user-api-keys */
export const adminUserApiKeysResponseSchema = z.object({
  apiKeys: z.array(userApiKeyResponseSchema),
  liveUsage: z.record(z.string(), apiKeyRateLimitUsageSchema),
  /** Requests per key from the usage log (90-day TTL), keyed by key id; absent keys made none. */
  requests: z.record(z.string(), adminApiKeyRequestCountsSchema),
  access: adminApiKeyAccessSchema,
});
