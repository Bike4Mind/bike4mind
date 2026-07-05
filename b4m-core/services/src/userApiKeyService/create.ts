import { ApiKeyScope, ApiKeyStatus, IUserApiKeyRepository } from '@bike4mind/common';
import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { KEY_PREFIX_LENGTH } from './constants';

const createUserApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ApiKeyScope)).min(1),
  expiresAt: z.date().optional(),
  rateLimit: z
    .object({
      requestsPerMinute: z.number().min(1).max(10_000).prefault(60),
      requestsPerDay: z.number().min(1).max(1_000_000).prefault(1000),
    })
    .optional(),
  metadata: z.object({
    clientIP: z.string().optional(),
    userAgent: z.string().optional(),
    createdFrom: z.enum(['dashboard', 'cli', 'api', 'bridge', 'overwatch-admin']),
    createdByUserId: z.string().optional(),
  }),
  productId: z.string().optional(),
  productName: z.string().optional(),
});

export type CreateUserApiKeyParameters = z.infer<typeof createUserApiKeySchema>;

interface CreateUserApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
  systemUserId?: string;
}

export interface CreateUserApiKeyResult {
  id: string;
  name: string;
  keyPrefix: string;
  key: string; // Only returned once during creation
  scopes: ApiKeyScope[];
  status: ApiKeyStatus;
  expiresAt?: Date;
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  metadata: {
    clientIP?: string;
    userAgent?: string;
    createdFrom: 'dashboard' | 'cli' | 'api' | 'bridge' | 'overwatch-admin';
    createdByUserId?: string;
  };
  productId?: string;
  productName?: string;
  createdAt: Date;
}

/**
 * Generate a secure API key with the format: b4m_live_[32_random_chars]
 */
function generateApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const randomPart = randomBytes(16).toString('hex'); // 32 chars
  const key = `b4m_live_${randomPart}`;
  const keyPrefix = key.substring(0, KEY_PREFIX_LENGTH);
  const keyHash = bcrypt.hashSync(key, 12);

  return { key, keyPrefix, keyHash };
}

export const createUserApiKey = async (
  userId: string,
  parameters: CreateUserApiKeyParameters,
  adapters: CreateUserApiKeyAdapters
): Promise<CreateUserApiKeyResult> => {
  const { db, systemUserId } = adapters;
  const params = secureParameters(parameters, createUserApiKeySchema);

  // OVERWATCH_INGEST_WRITE requires a productId
  if (params.scopes.includes(ApiKeyScope.OVERWATCH_INGEST_WRITE) && !params.productId) {
    throw new BadRequestError('productId is required for overwatch-ingest:write scope');
  }

  // Per-product cap: max 20 active keys (counts ACTIVE + RATE_LIMITED)
  if (params.productId) {
    const productActiveCount = await db.userApiKeys.countActiveByProductId(params.productId);
    if (productActiveCount >= 20) {
      throw new BadRequestError('Maximum 20 active ingest keys allowed per product');
    }
  }

  // Per-user cap: max 10 active keys. Skip only for the shared system user -
  // keyed on userId === systemUserId (NOT on scope) to prevent rogue-admin bypass.
  const MAX_ACTIVE_KEYS_PER_USER = 10;
  const isSystemUser = systemUserId && userId === systemUserId;
  if (!isSystemUser) {
    const activeCount = await db.userApiKeys.countActiveByUserId(userId);
    if (activeCount >= MAX_ACTIVE_KEYS_PER_USER) {
      throw new BadRequestError(`Maximum ${MAX_ACTIVE_KEYS_PER_USER} active API keys allowed per user`);
    }
  }

  const { key, keyPrefix, keyHash } = generateApiKey();

  const rateLimit = params.rateLimit || {
    requestsPerMinute: 60,
    requestsPerDay: 1000,
  };

  const apiKeyDocument = await db.userApiKeys.create({
    userId,
    name: params.name,
    keyHash,
    keyPrefix,
    scopes: params.scopes,
    status: ApiKeyStatus.ACTIVE,
    expiresAt: params.expiresAt,
    rateLimit,
    usage: {
      totalRequests: 0,
      totalTokens: 0,
      requestsToday: 0,
      requestsThisMinute: 0,
    },
    metadata: params.metadata,
    productId: params.productId,
    productName: params.productName,
  });

  return {
    id: apiKeyDocument.id,
    name: apiKeyDocument.name,
    keyPrefix: apiKeyDocument.keyPrefix,
    key, // This is the only time the raw key is returned
    scopes: apiKeyDocument.scopes,
    status: apiKeyDocument.status,
    expiresAt: apiKeyDocument.expiresAt,
    rateLimit: apiKeyDocument.rateLimit,
    metadata: apiKeyDocument.metadata,
    productId: apiKeyDocument.productId,
    productName: apiKeyDocument.productName,
    createdAt: apiKeyDocument.createdAt,
  };
};
