/**
 * Which part of a provider organization's spend belongs to this deployment.
 *
 * The provider admin reports are organization-wide, while the internal ledger counts only the stage
 * that wrote it. A scope narrows the provider side to this stage's workspaces/projects and API keys
 * before the two are compared. Ids are configured per stage at runtime (see
 * apps/workers/src/cron/providerSpendScope.ts), never in code. No scope means organization-wide.
 *
 * Filtering is done client-side on grouped rows rather than with the endpoints' filter params, so
 * one request yields both the scoped and the organization-wide total, and a scope dimension the
 * endpoint cannot group by is reported instead of silently ignored.
 */

import { z } from 'zod';

/** Anthropic reports the default workspace as `workspace_id: null`; configure it by this id. */
export const ANTHROPIC_DEFAULT_WORKSPACE_ID = 'default';

const idList = z.array(z.string().trim().min(1)).min(1);

export const AnthropicSpendScopeSchema = z
  .object({
    workspaceIds: idList.optional(),
    apiKeyIds: idList.optional(),
  })
  .strict();

export const OpenAISpendScopeSchema = z
  .object({
    projectIds: idList.optional(),
    apiKeyIds: idList.optional(),
  })
  .strict();

export type AnthropicSpendScope = z.infer<typeof AnthropicSpendScopeSchema>;
export type OpenAISpendScope = z.infer<typeof OpenAISpendScopeSchema>;

export interface ProviderSpendScopes {
  anthropic: AnthropicSpendScope;
  openai: OpenAISpendScope;
}

const SCHEMAS = {
  anthropic: AnthropicSpendScopeSchema,
  openai: OpenAISpendScopeSchema,
} as const;

/**
 * Parses a stored scope. Blank, `{}` or `org` means organization-wide and returns undefined. Any
 * other value must be valid JSON matching the provider's schema, or this throws: a typo must fail
 * the run, not silently widen the comparison back to the whole organization.
 */
export function parseProviderSpendScope<P extends keyof ProviderSpendScopes>(
  provider: P,
  raw: string | undefined
): ProviderSpendScopes[P] | undefined {
  const text = raw?.trim();
  if (!text || text === 'org') return undefined;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${provider} spend scope is not valid JSON`);
  }
  const parsed = SCHEMAS[provider].safeParse(json);
  if (!parsed.success) {
    throw new Error(`${provider} spend scope is invalid: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  }
  const scope = parsed.data as ProviderSpendScopes[P];
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function idInScope(allowed: readonly string[] | undefined, id: string): boolean {
  return !allowed || allowed.includes(id);
}

/** A grouped id the provider left null (e.g. Console usage with no API key) never matches a configured id. */
function groupedId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Shared by the cost and usage fetchers so both Anthropic reports apply the same scope. */
export function anthropicRowInScope(
  scope: AnthropicSpendScope | undefined,
  row: { workspace_id?: unknown; api_key_id?: unknown }
): boolean {
  const workspaceId =
    typeof row.workspace_id === 'string' && row.workspace_id ? row.workspace_id : ANTHROPIC_DEFAULT_WORKSPACE_ID;
  return idInScope(scope?.workspaceIds, workspaceId) && idInScope(scope?.apiKeyIds, groupedId(row.api_key_id));
}

/** Shared by the cost and usage fetchers so both OpenAI reports apply the same scope. */
export function openAIRowInScope(
  scope: OpenAISpendScope | undefined,
  row: { project_id?: unknown; api_key_id?: unknown }
): boolean {
  return (
    idInScope(scope?.projectIds, groupedId(row.project_id)) && idInScope(scope?.apiKeyIds, groupedId(row.api_key_id))
  );
}
