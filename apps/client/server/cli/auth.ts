import jwt from 'jsonwebtoken';
import { Config } from '@server/utils/config';
import {
  IUserDocument,
  ApiKeyScope,
  CreditHolderType,
  type ApiKeyBillingOwnerType,
  type CompletionSource,
  type IEmbedBranding,
} from '@bike4mind/common';
import { User, userApiKeyRepository, cacheRepository } from '@bike4mind/database';
import { userApiKeyService, cacheService } from '@bike4mind/services';
import { extractApiKeyFromHeaders, checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { hasAcceptedPolicy } from '@server/auth/consentGate';
import { z } from 'zod';

export interface VerifiedUser {
  id: string;
  email: string | null;
  username: string | null;
  user: IUserDocument;
}

export interface ApiKeyInfo {
  keyId: string;
  userId: string;
  scopes: ApiKeyScope[];
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  /** Billing target. Organization -> completions bill `organizationId`'s credit pool. */
  billingOwnerType?: ApiKeyBillingOwnerType;
  /** Organization whose pool this key bills, present iff billingOwnerType is Organization. */
  organizationId?: string;
  /** Agent an embed key is bound to, present iff scopes include `embed:chat`. */
  agentId?: string;
  /** Origins an embed key may be used from (defense-in-depth); embed keys only. */
  allowedOrigins?: string[];
  /** White-label config for an embed key; drives the widget serve route theming. */
  branding?: IEmbedBranding;
  /** Spend ceiling in credits for an embed key. Present 0 = real cap; absent = uncapped. */
  spendCap?: number;
  /** Cumulative settled spend in credits at validation time; embed keys only. */
  currentSpend?: number;
}

/**
 * Verify JWT token from Authorization header
 * @throws Error if token is invalid or expired
 */
export async function verifyJwtToken(token: string | undefined): Promise<VerifiedUser> {
  if (!token) {
    throw new Error('No authorization token provided');
  }

  try {
    const decoded = jwt.verify(token, Config.JWT_SECRET) as {
      id: string;
    };

    // Fetch the user from database to ensure they still exist
    const user = await User.findById(decoded.id);
    if (!user) {
      throw new Error('User not found');
    }

    // P0-B abuse gate: the REST consent middleware (auth.ts) only guards baseApi routes,
    // but the same session JWT authenticates the WebSocket + CLI Lambda LLM surfaces (cliCompletion,
    // agentExecute, completions function-URL, etc.) through THIS primitive. A brand-new OAuth account
    // is created without a recorded acceptance, so without this check it could drive provider spend
    // via a bearer token alone. Enforce the same fail-closed rule here - the JWT chokepoint every
    // JWT-authed LLM surface funnels through. (The API-key path is intentionally NOT gated: keys are
    // minted only through the gated REST surface, so a non-consented account can never hold one, and
    // gating it would cost a User.findById the completion hot path deliberately avoids.)
    if (!hasAcceptedPolicy(user)) {
      throw new Error('Policy acceptance required: accept the AUP/ToS and confirm 18+ before using this endpoint');
    }

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      user,
    };
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid authorization token');
    }
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Authorization token expired');
    }
    throw error;
  }
}

export interface VerifyApiKeyOptions {
  /** At least one of these scopes must be present on the key. Defaults to
   *  AI_GENERATE / AI_CHAT to preserve the legacy completions behavior. */
  requiredScopes?: ApiKeyScope[];
}

const DEFAULT_COMPLETION_SCOPES: ApiKeyScope[] = [ApiKeyScope.AI_GENERATE, ApiKeyScope.AI_CHAT];

/**
 * Project a (post-guard) validation result into an ApiKeyInfo. Single source for the
 * doc->info mapping, shared by verifyApiKey and verifyEmbedKeyById so the two can't
 * drift. Callers MUST have already asserted keyId/userId/scopes/rateLimit are present.
 */
function toApiKeyInfo(v: {
  keyId?: string;
  userId?: string;
  scopes?: ApiKeyScope[];
  rateLimit?: { requestsPerMinute: number; requestsPerDay: number };
  billingOwnerType?: ApiKeyBillingOwnerType;
  organizationId?: string;
  agentId?: string;
  allowedOrigins?: string[];
  branding?: IEmbedBranding;
  spendCap?: number;
  currentSpend?: number;
}): ApiKeyInfo {
  return {
    keyId: v.keyId!,
    userId: v.userId!,
    scopes: v.scopes!,
    rateLimit: v.rateLimit!,
    billingOwnerType: v.billingOwnerType,
    organizationId: v.organizationId,
    agentId: v.agentId,
    allowedOrigins: v.allowedOrigins,
    branding: v.branding,
    spendCap: v.spendCap,
    currentSpend: v.currentSpend,
  };
}

/**
 * Verify API key from headers
 * @throws Error if API key is invalid, expired, or missing required scope
 */
export async function verifyApiKey(
  headers: Record<string, string | undefined>,
  options?: VerifyApiKeyOptions
): Promise<ApiKeyInfo> {
  const apiKey = extractApiKeyFromHeaders(headers);

  if (!apiKey) {
    throw new Error('No API key provided');
  }

  try {
    const validation = await userApiKeyService.validateUserApiKey(apiKey, {
      db: { userApiKeys: userApiKeyRepository },
    });

    if (!validation.isValid || !validation.userId || !validation.keyId || !validation.scopes || !validation.rateLimit) {
      throw new Error(validation.reason ? `Invalid API key: ${validation.reason}` : 'Invalid or expired API key');
    }

    const requiredScopes = options?.requiredScopes ?? DEFAULT_COMPLETION_SCOPES;
    const hasRequiredScope = requiredScopes.some(s => validation.scopes!.includes(s));

    if (!hasRequiredScope) {
      const list = requiredScopes.join(' or ');
      throw new Error(`API key does not have permission for this endpoint (requires ${list})`);
    }

    return toApiKeyInfo(validation);
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Failed to verify API key');
  }
}

/**
 * Verify an API key that authorizes a cc-bridge WS action. Only the narrow
 * `CC_BRIDGE` scope is accepted - a leaked bridge key should have no ability
 * to bill completions or touch other endpoints.
 */
export async function verifyBridgeApiKey(headers: Record<string, string | undefined>): Promise<ApiKeyInfo> {
  return verifyApiKey(headers, { requiredScopes: [ApiKeyScope.CC_BRIDGE] });
}

/**
 * The two properties of the embed credential class, enforced on every embed
 * surface (session mint and chat) so neither can be reached with a key that
 * lacks them:
 *   - org-only: usage bills a bounded Organization pool, never a user's pool.
 *   - a bound agent: the key resolves exactly one agent; without it there is no
 *     persona/tenant to run, so fail closed.
 */
function assertEmbedCredential(info: ApiKeyInfo): void {
  if (info.billingOwnerType !== CreditHolderType.Organization || !info.organizationId) {
    throw new Error('Embed keys must be organization-owned');
  }
  if (!info.agentId) {
    throw new Error('Embed key is not bound to an agent');
  }
}

/**
 * Verify an API key that authorizes the public embed completion surface (the
 * raw-key path: X-API-Key / Authorization). Requires the EMBED_CHAT scope plus
 * the embed credential-class properties above.
 * @throws Error if the key lacks EMBED_CHAT, is not org-owned, or has no agent.
 */
export async function verifyEmbedApiKey(headers: Record<string, string | undefined>): Promise<ApiKeyInfo> {
  const info = await verifyApiKey(headers, { requiredScopes: [ApiKeyScope.EMBED_CHAT] });
  assertEmbedCredential(info);
  return info;
}

/**
 * Resolve an embed key by its id (the session-token path, where the raw secret
 * is not in hand). Re-loads the live key doc and re-applies the ACTIVE-status,
 * scope, and credential-class checks, so a session token cannot outlive a key
 * that was revoked/disabled within its short TTL - the revocation-safety the
 * token itself cannot provide.
 * @throws Error if the key is missing, not active, or not a valid embed key.
 */
export async function verifyEmbedKeyById(keyId: string): Promise<ApiKeyInfo> {
  // Share the exact post-lookup gates (status, expiry, last-used, projection) with
  // the raw-key path via validateUserApiKeyById, so a future gate added to key
  // validation propagates to the session-token path automatically.
  const validation = await userApiKeyService.validateUserApiKeyById(keyId, {
    db: { userApiKeys: userApiKeyRepository },
  });

  if (!validation.isValid || !validation.userId || !validation.keyId || !validation.scopes || !validation.rateLimit) {
    throw new Error(validation.reason ? `Invalid embed key: ${validation.reason}` : 'Invalid or expired embed key');
  }
  if (!validation.scopes.includes(ApiKeyScope.EMBED_CHAT)) {
    throw new Error('API key does not have permission for this endpoint (requires embed:chat)');
  }

  const info = toApiKeyInfo(validation);
  assertEmbedCredential(info);
  return info;
}

/**
 * Check API key rate limits
 * @param apiKeyInfo - API key information including rate limits
 * @param context - Optional context for analytics logging (userId, endpoint, method)
 * @throws Error if rate limit is exceeded
 * @returns Rate limit headers to include in response
 */
export async function checkApiKeyRateLimitOrThrow(
  apiKeyInfo: ApiKeyInfo,
  context?: { userId?: string; endpoint: string; method: string }
): Promise<Record<string, number>> {
  const result = await checkApiKeyRateLimit(apiKeyInfo.keyId, apiKeyInfo.rateLimit, context);

  if (!result.allowed) {
    throw new Error(result.error || 'Rate limit exceeded');
  }

  return result.headers;
}

/**
 * Per-user JWT rate limiter for the CLI HTTP completions endpoint and the
 * WebSocket agent/tool handlers. Backed by the shared cache service (same
 * store the HTTP `rateLimit` middleware uses) so the window is coherent
 * across Lambda containers - an in-memory Map would reset on every cold
 * start, effectively disabling the limit under Lambda concurrency.
 *
 * Per-source caps: a single CLI "turn" fans out into N completions via the
 * tool loop (read -> edit -> typecheck -> edit -> ...), so the CLI surface
 * needs a much higher ceiling than browser/WS chat usage.
 */
const JWT_RATE_LIMIT_BY_SOURCE: Record<CompletionSource, number> = {
  cli: 1000,
  agent: 1000,
  api: 100,
  web: 100,
  system: 100,
};
const JWT_RATE_LIMIT_DEFAULT = 100;
const JWT_RATE_WINDOW_MS = 60 * 60_000; // 1 hour

function getJwtRateLimit(source?: CompletionSource): number {
  if (!source) return JWT_RATE_LIMIT_DEFAULT;
  return JWT_RATE_LIMIT_BY_SOURCE[source] ?? JWT_RATE_LIMIT_DEFAULT;
}

/**
 * Increment the per-user JWT request counter and throw if the per-hour cap
 * for the calling surface has been reached.
 *
 * Uses a **fixed window**: the first request in a window sets the TTL to 1
 * hour; subsequent increments within that window preserve the original
 * expiry so the window closes a bounded time after it opened. The previous
 * implementation reset the TTL to a full hour on every increment, which
 * turned the window into a perpetually-sliding lockout - an active user who
 * hit the cap could never recover without going idle for a full hour from
 * their *most recent* request.
 */
export async function checkRateLimit(userId: string, source?: CompletionSource): Promise<void> {
  const key = `rate-limit:ws-auth:${userId}`;
  const adapters = { db: { caches: cacheRepository } };
  const limit = getJwtRateLimit(source);

  const current = await cacheService.get({ key }, { ...adapters, schema: z.coerce.number() });
  if (current === null) {
    await cacheService.set<number>({ key, value: 1, ttl: JWT_RATE_WINDOW_MS }, adapters);
    return;
  }

  if (current >= limit) {
    const ttl = await cacheService.ttl({ key }, adapters);
    const resetSeconds = Math.ceil((ttl > 0 ? ttl : JWT_RATE_WINDOW_MS) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSeconds} seconds.`);
  }

  // Preserve the remaining window - do NOT reset TTL on increment.
  const remainingTtl = await cacheService.ttl({ key }, adapters);
  const ttlMs = remainingTtl > 0 ? remainingTtl : JWT_RATE_WINDOW_MS;
  await cacheService.set<number>({ key, value: current + 1, ttl: ttlMs }, adapters);
}
