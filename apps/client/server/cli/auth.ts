import jwt from 'jsonwebtoken';
import { Config } from '@server/utils/config';
import { IUserDocument, ApiKeyScope, type ApiKeyBillingOwnerType, type CompletionSource } from '@bike4mind/common';
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

    return {
      keyId: validation.keyId,
      userId: validation.userId,
      scopes: validation.scopes,
      rateLimit: validation.rateLimit,
      billingOwnerType: validation.billingOwnerType,
      organizationId: validation.organizationId,
    };
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
