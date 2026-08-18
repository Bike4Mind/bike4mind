import {
  ApiKeyBillingOwnerType,
  ApiKeyScope,
  ApiKeyStatus,
  CreditHolderType,
  EmbedBrandingSchema,
  EmbedOriginsSchema,
  IEmbedBranding,
  IUserApiKeyRepository,
} from '@bike4mind/common';
import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { KEY_PREFIX_LENGTH } from './constants';
import { API_KEY_RATE_LIMIT_DEFAULTS, apiKeyRateLimitSchema } from './rateLimit';

// Sanity ceiling for a per-embed-key spend cap, in whole credits - a guard against
// fat-finger/overflow values, not a product limit. Shared with the spend-cap update
// path (setEmbedKeySpendCap).
export const EMBED_SPEND_CAP_MAX_CREDITS = 100_000_000;

const createUserApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ApiKeyScope)).min(1),
  expiresAt: z.date().optional(),
  // Embed key (epic #41). `allowedOrigins` reuses the common schema (dedup + cap;
  // each entry must be an already-normalized exact https origin). Host-aware
  // first-party rejection lives at the mint route, which has the runtime host.
  // `.min(1)`: an empty-string agentId is never meaningful and must not slip past
  // the coherence guard below (which the route mirrors via `!== undefined`).
  agentId: z.string().min(1).optional(),
  allowedOrigins: EmbedOriginsSchema.optional(),
  branding: EmbedBrandingSchema.optional(),
  // Spend settles in whole credits, so a fractional cap has no resolution.
  // `.positive()` rejects a 0 cap at mint (a dead-on-arrival key), but enforcement
  // still honors a stored 0 as a real cap.
  spendCap: z.number().int().positive().max(EMBED_SPEND_CAP_MAX_CREDITS).optional(),
  // Bounds live in ./rateLimit so mint and update can never accept different values.
  rateLimit: apiKeyRateLimitSchema.optional(),
  metadata: z.object({
    clientIP: z.string().optional(),
    userAgent: z.string().optional(),
    createdFrom: z.enum(['dashboard', 'cli', 'api', 'bridge', 'overwatch-admin', 'oauth-exchange']),
    createdByUserId: z.string().optional(),
    // Tags a key minted by the federated AI-token exchange to its (user, client) pair.
    oauthClientId: z.string().optional(),
  }),
  productId: z.string().optional(),
  productName: z.string().optional(),
  // Billing target. Organization keys route usage to `organizationId`'s credit
  // pool. Authorization (is the caller allowed to mint for this org?) is enforced
  // by the route; the service only enforces the field-shape invariant below.
  billingOwnerType: z.enum(CreditHolderType).optional(),
  organizationId: z.string().optional(),
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
    createdFrom: 'dashboard' | 'cli' | 'api' | 'bridge' | 'overwatch-admin' | 'oauth-exchange';
    createdByUserId?: string;
    oauthClientId?: string;
  };
  productId?: string;
  productName?: string;
  billingOwnerType?: ApiKeyBillingOwnerType;
  organizationId?: string;
  agentId?: string;
  allowedOrigins?: string[];
  branding?: IEmbedBranding;
  spendCap?: number;
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

  // Embed key invariants: an embed:chat key is always bound to one agent, and the
  // embed-only fields are meaningless without the scope (mirrors the OVERWATCH check).
  const isEmbedKey = params.scopes.includes(ApiKeyScope.EMBED_CHAT);
  if (isEmbedKey && !params.agentId) {
    throw new BadRequestError('agentId is required for embed:chat scope');
  }
  // Embed keys bill a bounded Organization pool, never a user's. Enforce the org
  // pairing at mint so an incoherent key is never created (e.g. a forged/scripted
  // request bypassing the admin UI). Must match assertEmbedCredential in
  // apps/client/server/cli/auth.ts, which rejects a non-org-owned embed key at serve/session.
  if (isEmbedKey && (params.billingOwnerType !== CreditHolderType.Organization || !params.organizationId)) {
    throw new BadRequestError(
      'embed:chat scope requires organization billing (billingOwnerType Organization with an organizationId)'
    );
  }
  if (
    !isEmbedKey &&
    (params.agentId !== undefined ||
      params.allowedOrigins !== undefined ||
      params.branding !== undefined ||
      params.spendCap !== undefined)
  ) {
    throw new BadRequestError('agentId, allowedOrigins, branding, and spendCap require the embed:chat scope');
  }

  // Billing-target invariant: Organization iff organizationId is set. Keys bill a
  // user or an org, never an agent. The route is responsible for verifying the
  // caller may mint against this org; here we only guarantee a coherent record.
  if (params.billingOwnerType === CreditHolderType.Agent) {
    throw new BadRequestError('API keys cannot be billed to an agent');
  }
  const billsOrg = params.billingOwnerType === CreditHolderType.Organization;
  if (billsOrg !== !!params.organizationId) {
    throw new BadRequestError('organizationId must be set exactly when billingOwnerType is Organization');
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

  const rateLimit = params.rateLimit || API_KEY_RATE_LIMIT_DEFAULTS;

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
    billingOwnerType: params.billingOwnerType ?? CreditHolderType.User,
    organizationId: params.organizationId,
    agentId: params.agentId,
    allowedOrigins: params.allowedOrigins,
    branding: params.branding,
    spendCap: params.spendCap,
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
    billingOwnerType: apiKeyDocument.billingOwnerType,
    organizationId: apiKeyDocument.organizationId,
    agentId: apiKeyDocument.agentId,
    allowedOrigins: apiKeyDocument.allowedOrigins,
    branding: apiKeyDocument.branding,
    spendCap: apiKeyDocument.spendCap,
    createdAt: apiKeyDocument.createdAt,
  };
};
