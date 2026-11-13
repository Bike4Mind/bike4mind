import { z } from 'zod';
import { ModelBackend } from '../models';
import { b4mLLMTools, DATA_LAKE_TOOL_NAMES } from './llm';

/**
 * An organization's allowlist of model providers, model ids and built-in tools. Each list is
 * `null` for unrestricted. Providers and models need at least one entry so an org cannot lock its
 * members out of every model; `allowedTools: []` is valid and withholds every built-in tool.
 */
export const OrgModelPolicySchema = z
  .object({
    allowedProviders: z.array(z.nativeEnum(ModelBackend)).min(1).max(50).nullable().default(null),
    allowedModels: z.array(z.string().trim().min(1).max(200)).min(1).max(500).nullable().default(null),
    allowedTools: z.array(b4mLLMTools).max(100).nullable().default(null),
  })
  .strict();

export type OrgModelPolicy = z.infer<typeof OrgModelPolicySchema>;

/**
 * A stored policy that no longer parses. Callers treat it as deny-all for everything the policy
 * governs, so a corrupt row fails closed instead of lifting the restriction.
 */
export const INVALID_ORG_MODEL_POLICY = 'invalid' as const;
export type ReadOrgModelPolicy = OrgModelPolicy | null | typeof INVALID_ORG_MODEL_POLICY;

/** Parse `organization.modelPolicy` as stored. Absent or null reads as unrestricted (`null`). */
export function readOrgModelPolicy(raw: unknown): ReadOrgModelPolicy {
  if (raw === undefined || raw === null) return null;
  const parsed = OrgModelPolicySchema.safeParse(normalizeStoredPolicy(raw));
  if (!parsed.success) return INVALID_ORG_MODEL_POLICY;
  const { allowedProviders, allowedModels, allowedTools } = parsed.data;
  if (allowedProviders === null && allowedModels === null && allowedTools === null) return null;
  return parsed.data;
}

// Mongoose hands back a subdocument whose unset array paths read as undefined; drop those keys so
// .strict() and .default(null) see the same shape the API wrote.
function normalizeStoredPolicy(raw: unknown): unknown {
  if (typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const source =
    typeof (raw as { toObject?: unknown }).toObject === 'function'
      ? (raw as { toObject: () => Record<string, unknown> }).toObject()
      : (raw as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === '_id' || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Whether the org allows a model. Both lists must admit it. A model whose backend is unknown is
 * refused once `allowedProviders` is set, since there is no provider to match it against.
 */
export function isModelAllowedByOrgPolicy(
  policy: ReadOrgModelPolicy,
  model: { id: string; backend?: ModelBackend | string | null }
): boolean {
  if (policy === null) return true;
  if (policy === INVALID_ORG_MODEL_POLICY) return false;
  if (policy.allowedModels !== null && !policy.allowedModels.includes(model.id)) return false;
  if (policy.allowedProviders !== null) {
    if (!model.backend) return false;
    if (!(policy.allowedProviders as readonly string[]).includes(model.backend)) return false;
  }
  return true;
}

const GOVERNED_TOOL_NAMES: ReadonlySet<string> = new Set(b4mLLMTools.options);

// Same pairings as resolveEnabledTools (services ChatCompletionProcess) and pairDataLakeTools: a
// companion is allowed whenever the tool it rides along with is.
const TOOL_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  image_generation: ['edit_image'],
  search_knowledge_base: ['retrieve_knowledge_content', 'count_knowledge_base', 'describe_knowledge_base'],
  save_content_to_data_lake: DATA_LAKE_TOOL_NAMES.filter(name => name !== 'save_content_to_data_lake'),
};

/** `allowedTools` plus every companion its entries pair in. */
export function expandOrgAllowedTools(allowedTools: readonly string[]): Set<string> {
  const out = new Set(allowedTools);
  for (const tool of allowedTools) {
    for (const companion of TOOL_COMPANIONS[tool] ?? []) out.add(companion);
  }
  return out;
}

/**
 * Whether the org allows a tool. Only built-in tool names (`b4mLLMTools`) are governed; MCP tools
 * (`server__tool`), coordinator tools and premium-merged tools outside that enum always pass.
 */
export function isToolAllowedByOrgPolicy(policy: ReadOrgModelPolicy, toolName: string): boolean {
  if (policy === null) return true;
  if (!GOVERNED_TOOL_NAMES.has(toolName)) return true;
  if (policy === INVALID_ORG_MODEL_POLICY) return false;
  if (policy.allowedTools === null) return true;
  return expandOrgAllowedTools(policy.allowedTools).has(toolName);
}
