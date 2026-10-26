import jwt from 'jsonwebtoken';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  IUserDocument,
  ApiKeyScope,
  ApiKeyScopeValue,
  CreditHolderType,
  type ApiKeyBillingOwnerType,
  type CompletionSource,
  type IEmbedBranding,
} from '@bike4mind/common';
import { User, userApiKeyRepository, cacheRepository } from '@bike4mind/database';
import { userApiKeyService, cacheService, isTokenVersionCurrent, isTokenTypeAcceptable } from '@bike4mind/services';
import { extractApiKeyFromHeaders, checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { hasAcceptedPolicy } from '@bike4mind/server-utils/auth/consentGate';
import { assertAccountStateUsable } from '@server/auth/assertAccountStateUsable';
import { isMfaEnrollmentOwed, MFA_ENROLLMENT_REQUIRED_MESSAGE } from '@server/auth/mfaEnforcement';
import { UnauthorizedError, ForbiddenError, TooManyRequestsError } from '@bike4mind/server-utils/utils/errors';
import { toApiKeyAuthError } from '@server/auth/apiKeyAuthFailure';
import { applyUntrustedRateLimit } from '@server/utils/apiKeyTrust';
import { z } from 'zod';

/** `additionalInfo` of a rate-limit TooManyRequestsError; transports turn it into response headers. */
export type RateLimitErrorInfo = {
  retryAfter?: number;
  rateLimitHeaders?: Record<string, string | number>;
};

export interface VerifiedUser {
  id: string;
  email: string | null;
  username: string | null;
  user: IUserDocument;
}

export interface ApiKeyInfo {
  keyId: string;
  userId: string;
  scopes: ApiKeyScopeValue[];
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
  /** OAuth clients allowed to mint identified sessions on this embed key. */
  identifiedClientIds?: string[];
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
    // Pin HS256 to match the REST strategy / verifyRefreshToken (no algorithm-confusion surface).
    const decoded = jwt.verify(token, Config.JWT_SECRET, { algorithms: ['HS256'] }) as {
      id: string;
      tokenVersion?: number;
      mfaPending?: boolean;
      typ?: string;
      kind?: string;
      impersonatedBy?: string;
    };

    // A relying-party OAuth access token is scope/audience-bound to OAuth-reachable REST routes
    // (see oauthRouteGate) and must NOT drive the CLI/LLM surfaces this primitive backs. The route
    // gate does not cover this path, so default-deny the OAuth kind here explicitly.
    if (decoded.kind === 'oauth') {
      throw new Error('OAuth access tokens are not accepted on this endpoint');
    }

    // Reject a first-factor-only token: the mfaPending access token (issued pre-2FA, before the
    // second factor) must NOT drive these LLM/CLI surfaces. Mirrors the REST strategy's mfaPending
    // gate; without it, the second factor is bypassable on every surface this primitive backs.
    if (decoded.mfaPending) {
      throw new Error('MFA verification required');
    }

    // Reject a token minted for a different path (e.g. a refresh token presented here as an access
    // bearer). Missing typ = legacy pre-claim token, accepted (self-expiring grace). Same shared
    // helper the REST strategy and verifyRefreshToken use, so all verifiers agree.
    if (!isTokenTypeAcceptable(decoded.typ, 'access')) {
      throw new Error('Invalid token type');
    }

    // Fetch the user from database to ensure they still exist
    const user = await User.findById(decoded.id);
    if (!user) {
      throw new Error('User not found');
    }

    // Server-side kill switch: honor tokenVersion here too. Without it, a revoked session
    // (logout / admin force-logout / MFA or security bump) keeps working on these surfaces until
    // its natural TTL - the REST strategy + WS connect enforce this, this primitive did not.
    // Legacy tokens carry no version and normalize to 0 (no mass logout on deploy).
    if (!isTokenVersionCurrent(decoded.tokenVersion, user.tokenVersion)) {
      throw new Error('Session expired');
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

    // Account state (ban / chargeback / suspension) lands AFTER this JWT was minted and does
    // not bump tokenVersion, so a still-valid session JWT would otherwise sail through. The
    // WS/CLI completion surfaces fall back to this primitive, so apply the same gate
    // verifyApiKey applies via assertOwnerAccountUsable - user is already loaded here.
    assertAccountStateUsable(user);

    // enforceMFA binds sessions minted before it applied, on these surfaces as on REST (auth.ts).
    // ForbiddenError so a transport that maps error classes (the Function-URL adapter, the
    // ws-completions JWT catch) answers 403 with this message rather than a generic 401.
    if (await isMfaEnrollmentOwed(user, { impersonatedBy: decoded.impersonatedBy })) {
      throw new ForbiddenError(`${MFA_ENROLLMENT_REQUIRED_MESSAGE} Set it up in the web app to continue.`);
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
  requiredScopes?: ApiKeyScopeValue[];
}

/**
 * This file is the SECOND place API-key scopes are decided; the first is
 * `server/middlewares/apiKeyScopeGate.ts`, which the baseApi chain uses. Requests
 * arriving here (CLI, Fargate, WebSocket, embed) never traverse that gate, so
 * CONFINED_SCOPES is not applied to them - safe only because none of these defaults
 * name a confined scope. Adding one here, or widening this list, needs the
 * confinement rule brought across too.
 */
const DEFAULT_COMPLETION_SCOPES: ApiKeyScope[] = [ApiKeyScope.AI_GENERATE, ApiKeyScope.AI_CHAT];

/**
 * Project a (post-guard) validation result into an ApiKeyInfo. Single source for the
 * doc->info mapping, shared by verifyApiKey and verifyEmbedKeyById so the two can't
 * drift. Callers MUST have already asserted keyId/userId/scopes/rateLimit are present.
 */
function toApiKeyInfo(v: {
  keyId?: string;
  userId?: string;
  scopes?: ApiKeyScopeValue[];
  rateLimit?: { requestsPerMinute: number; requestsPerDay: number };
  billingOwnerType?: ApiKeyBillingOwnerType;
  organizationId?: string;
  agentId?: string;
  allowedOrigins?: string[];
  identifiedClientIds?: string[];
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
    identifiedClientIds: v.identifiedClientIds,
    branding: v.branding,
    spendCap: v.spendCap,
    currentSpend: v.currentSpend,
  };
}

/**
 * The account-state gates `apiKeyAuth` applies on the `baseApi` surface, mirrored
 * for the contract/CLI/Fargate/WebSocket paths, which reach a key without ever
 * touching that middleware. Without this a banned, charged-back or suspended
 * owner's key kept working on exactly the surfaces that spend money.
 *
 * Exactly one copy of the gate: `apiKeyAuth` calls {@link assertAccountStateUsable} rather than
 * repeating these conditions. The thrown error class is the status contract: the Function-URL
 * adapter (defineLambdaRoute) answers a ForbiddenError with 403, a 5xx HTTPError (see
 * toApiKeyAuthError) with that status, and every other auth throw with 401, and the apiKeyOrJwt resolver (resolveContractAuth) surfaces a key's ForbiddenError when
 * the JWT fallback also fails. No apiKeyOrJwt transport forwards it yet: its only caller, the
 * Fargate SSE route (sseRoute.ts), reports any auth throw as a generic failure.
 *
 * This is the `User.findById` the consent gate above deliberately declines to pay
 * on the api-key path. Account state is not the same trade: consent can be proven
 * at mint time and never changes underneath a key, whereas a ban, chargeback or
 * suspension lands *after* the key exists and must take effect on the surfaces
 * that spend money.
 */
async function assertOwnerAccountUsable(userId: string) {
  const user = await User.findById(userId);
  if (!user) {
    throw new UnauthorizedError('User not found or banned');
  }
  assertAccountStateUsable(user);
  return user;
}

/**
 * Verify API key from headers
 * @throws UnauthorizedError/ForbiddenError if API key is invalid, expired, missing required scope, or
 * owned by a banned/disputed/suspended account; a 5xx HTTPError (see toApiKeyAuthError) when the
 * check itself fails, e.g. the database is unreachable
 */
export async function verifyApiKey(
  headers: Record<string, string | undefined>,
  options?: VerifyApiKeyOptions
): Promise<ApiKeyInfo> {
  const apiKey = extractApiKeyFromHeaders(headers);

  if (!apiKey) {
    throw new UnauthorizedError('No API key provided');
  }

  try {
    const validation = await userApiKeyService.validateUserApiKey(apiKey, {
      db: { userApiKeys: userApiKeyRepository },
    });

    if (!validation.isValid || !validation.userId || !validation.keyId || !validation.scopes || !validation.rateLimit) {
      throw new UnauthorizedError(
        validation.reason ? `Invalid API key: ${validation.reason}` : 'Invalid or expired API key'
      );
    }

    const requiredScopes = options?.requiredScopes ?? DEFAULT_COMPLETION_SCOPES;
    const hasRequiredScope = requiredScopes.some(s => validation.scopes!.includes(s));

    if (!hasRequiredScope) {
      const list = requiredScopes.join(' or ');
      throw new ForbiddenError(`API key does not have permission for this endpoint (requires ${list})`, {
        required_scopes: requiredScopes,
      });
    }

    const owner = await assertOwnerAccountUsable(validation.userId);
    const info = toApiKeyInfo(validation);
    // Same untrusted-owner ceiling apiKeyAuth applies, so these surfaces meter the clamped limit too.
    return { ...info, rateLimit: await applyUntrustedRateLimit(owner, info) };
  } catch (error) {
    throw toApiKeyAuthError(error);
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
    throw new UnauthorizedError('Embed keys must be organization-owned');
  }
  if (!info.agentId) {
    throw new UnauthorizedError('Embed key is not bound to an agent');
  }
}

/**
 * Verify an API key that authorizes the public embed completion surface (the
 * raw-key path: X-API-Key / Authorization). Requires the EMBED_CHAT scope plus
 * the embed credential-class properties above.
 * @throws UnauthorizedError/ForbiddenError if the key lacks EMBED_CHAT, is not org-owned, or has no
 * agent; a 5xx HTTPError (see toApiKeyAuthError) when the check itself fails, e.g. the database is
 * unreachable
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
 * @throws UnauthorizedError if the key is missing, not active, or not a valid embed key;
 * a 5xx HTTPError (see toApiKeyAuthError) when the check itself fails.
 */
export async function verifyEmbedKeyById(keyId: string): Promise<ApiKeyInfo> {
  try {
    // Share the exact post-lookup gates (status, expiry, last-used, projection) with
    // the raw-key path via validateUserApiKeyById, so a future gate added to key
    // validation propagates to the session-token path automatically.
    const validation = await userApiKeyService.validateUserApiKeyById(keyId, {
      db: { userApiKeys: userApiKeyRepository },
    });

    if (!validation.isValid || !validation.userId || !validation.keyId || !validation.scopes || !validation.rateLimit) {
      throw new UnauthorizedError(
        validation.reason ? `Invalid embed key: ${validation.reason}` : 'Invalid or expired embed key'
      );
    }
    if (!validation.scopes.includes(ApiKeyScope.EMBED_CHAT)) {
      throw new UnauthorizedError('API key does not have permission for this endpoint (requires embed:chat)');
    }

    const info = toApiKeyInfo(validation);
    assertEmbedCredential(info);
    await assertOwnerAccountUsable(info.userId);
    return info;
  } catch (error) {
    throw toApiKeyAuthError(error);
  }
}

/**
 * Check API key rate limits
 * @param apiKeyInfo - API key information including rate limits
 * @param context - Optional context for analytics logging (userId, endpoint, method)
 * @throws TooManyRequestsError if the limit is exceeded, with `retryAfter` (seconds) and
 *   `rateLimitHeaders` in additionalInfo for the transport to set as response headers
 * @returns Rate limit headers to include in response
 */
export async function checkApiKeyRateLimitOrThrow(
  apiKeyInfo: ApiKeyInfo,
  context?: { userId?: string; endpoint: string; method: string }
): Promise<Record<string, number>> {
  const result = await checkApiKeyRateLimit(apiKeyInfo.keyId, apiKeyInfo.rateLimit, context);

  if (!result.allowed) {
    const info = { retryAfter: result.retryAfter, rateLimitHeaders: result.headers } satisfies RateLimitErrorInfo;
    throw new TooManyRequestsError(result.error || 'Rate limit exceeded', info);
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
  // Never applies: a desktop request matches the client bucket below first and gets its cap.
  desktop: 100,
  agent: 1000,
  api: 100,
  web: 100,
  system: 100,
};
const JWT_RATE_LIMIT_DEFAULT = 100;
const JWT_RATE_WINDOW_MS = 60 * 60_000; // 1 hour

/**
 * A counter kept apart from the shared per-user one. Callers without a bucket share a single
 * counter across every surface, so a session running at a 1000 cap would exhaust a 100-cap
 * endpoint on the same account. A public endpoint that documents its own budget needs its own
 * bucket.
 *
 * - `ws` holds the 100-cap WebSocket handlers (tool execution, agent execute, keep relay,
 *   cc-agent auth).
 * - `completions` holds the sources whose cap is above the default (`cli`, `agent`); it is
 *   derived from `source`, so the unbucketed counter only ever carries 100-cap sources.
 */
export type JwtRateLimitBucket = 'tools' | 'desktop' | 'ws' | 'completions';

/**
 * Per-client caps for first-party clients that run a client-side tool loop against the
 * completions endpoint - one turn fans out into one completion per tool round, so their ceiling
 * has to be counted in rounds rather than turns. Matched on the client signal from
 * `resolveRequestClient` (User-Agent, then x-b4m-client), the same one `resolveApiCompletionSource`
 * uses for `b4m-cli/`. Every HTTP completions route that rate-limits a JWT caller must pass it as
 * `client`, or the per-client cap silently falls back to the default.
 *
 * Each entry carries its own bucket, and the limit and the key are read from the SAME match, so
 * a raised ceiling cannot spend a counter another surface reads. Without that, a desktop session
 * past 1000 would lock the same user's CLI out of its own 1000 until the window closed - see the
 * JwtRateLimitBucket note above.
 *
 * Source attribution is resolved separately by the shared request classifier.
 */
const JWT_RATE_LIMIT_BY_CLIENT: ReadonlyArray<{ pattern: RegExp; limit: number; bucket: JwtRateLimitBucket }> = [
  { pattern: /^b4m-desktop\//i, limit: 6000, bucket: 'desktop' },
];

function matchClient(client?: string) {
  return client ? JWT_RATE_LIMIT_BY_CLIENT.find(entry => entry.pattern.test(client)) : undefined;
}

function getJwtRateLimit(source?: CompletionSource): number {
  if (!source) return JWT_RATE_LIMIT_DEFAULT;
  return JWT_RATE_LIMIT_BY_SOURCE[source] ?? JWT_RATE_LIMIT_DEFAULT;
}

/** Sources raised above the default cap must not spend the counter the 100-cap sources read. */
function bucketForSource(source?: CompletionSource): JwtRateLimitBucket | undefined {
  return getJwtRateLimit(source) > JWT_RATE_LIMIT_DEFAULT ? 'completions' : undefined;
}

function jwtRateLimitKey(userId: string, bucket?: JwtRateLimitBucket): string {
  return bucket ? `rate-limit:ws-auth:${bucket}:${userId}` : `rate-limit:ws-auth:${userId}`;
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
 *
 * @throws TooManyRequestsError with `additionalInfo.retryAfter` (seconds left in the window)
 */
export async function checkRateLimit(
  userId: string,
  source?: CompletionSource,
  options: { bucket?: JwtRateLimitBucket; client?: string } = {}
): Promise<void> {
  // One match drives both: an explicit bucket still wins, but a client-matched cap always
  // brings its own counter with it.
  const byClient = matchClient(options.client);
  const key = jwtRateLimitKey(userId, options.bucket ?? byClient?.bucket ?? bucketForSource(source));
  const adapters = { db: { caches: cacheRepository } };
  const limit = byClient?.limit ?? getJwtRateLimit(source);

  const current = await cacheService.get({ key }, { ...adapters, schema: z.coerce.number() });
  if (current === null) {
    await cacheService.set<number>({ key, value: 1, ttl: JWT_RATE_WINDOW_MS }, adapters);
    return;
  }

  if (current >= limit) {
    const ttl = await cacheService.ttl({ key }, adapters);
    const resetSeconds = Math.ceil((ttl > 0 ? ttl : JWT_RATE_WINDOW_MS) / 1000);
    const info = { retryAfter: resetSeconds } satisfies RateLimitErrorInfo;
    throw new TooManyRequestsError(`Rate limit exceeded. Try again in ${resetSeconds} seconds.`, info);
  }

  // Preserve the remaining window - do NOT reset TTL on increment.
  const remainingTtl = await cacheService.ttl({ key }, adapters);
  const ttlMs = remainingTtl > 0 ? remainingTtl : JWT_RATE_WINDOW_MS;
  await cacheService.set<number>({ key, value: current + 1, ttl: ttlMs }, adapters);
}
