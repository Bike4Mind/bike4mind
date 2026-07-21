import { registry } from './registry';
import { ApiKeyScope } from '../types/entities/UserApiKeyTypes';

/**
 * Security schemes, declared once and referenced by every operation.
 *
 * Both accept the same `b4m_live_<key>` secret; `bearerAuth` is the canonical
 * form and `apiKeyAuth` the legacy header. A third accepted form,
 * `Authorization: ApiKey <key>`, is documented in the descriptions rather than
 * as its own scheme (OpenAPI has no distinct type for it; it shares the bearer
 * slot semantically). Must stay in sync with `extractApiKeyFromHeaders`
 * (apps/client/server/utils/apiKeyRateLimitCheck.ts).
 */
export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Canonical auth. Send `Authorization: Bearer b4m_live_<key>`. A JWT access token is also ' +
    'accepted in this header; a token beginning with `b4m_` is treated as an API key, anything ' +
    'else as a JWT.',
});

export const apiKeyAuth = registry.registerComponent('securitySchemes', 'apiKeyAuth', {
  type: 'apiKey',
  in: 'header',
  name: 'x-api-key',
  description: 'Legacy auth. Send `x-api-key: b4m_live_<key>`. Equivalent to `bearerAuth` for API keys.',
});

/**
 * Security requirement referenced by every operation: either scheme grants
 * access. Scope arrays are empty because OpenAPI only honors scopes for
 * oauth2/openIdConnect schemes; the per-operation scope contract is published
 * via the `x-required-scopes` vendor extension and the operation description
 * instead. See {@link REQUIRED_SCOPES}.
 */
export const SECURITY_REQUIREMENT: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

/**
 * Canonical API key scopes, sourced verbatim from the runtime {@link ApiKeyScope}
 * enum - the single source of truth for what a key may do. Published in
 * `info.description` so consumers see the real grant vocabulary (e.g. `ai:chat`),
 * not an aspirational one. If the enum changes, this list changes with it.
 */
export const ALL_API_KEY_SCOPES: string[] = Object.values(ApiKeyScope);

/** Scopes an operation expects, surfaced per-operation via `x-required-scopes`. */
export const REQUIRED_SCOPES = {
  createCompletion: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  executeTool: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
} as const;
