import { z } from 'zod';
import { PublicModelSchema } from './publicModel';

/**
 * Public wire schema for `GET /api/v1/client-config` - what an API client needs to
 * configure itself, in one call.
 *
 * Every field is hand-picked, never a pass-through of admin settings: a new admin
 * setting reaches this response only when someone adds it here on purpose. The
 * caller's identity, plan and entitlements are NOT repeated - they live on
 * `GET /api/v1/me` (MeResponseSchema), which changes on purchase while this payload
 * changes on deploy or admin action.
 *
 * Public-API rules apply: snake_case wire fields, no `.catch()`, no top-level
 * `.transform()`.
 */

/**
 * Mirrors `ServerStatusEnum` (schemas/settings.ts), spelled out so a contract importing this file
 * does not pull in the whole settings catalog. clientConfig.test.ts keeps the two in sync.
 */
export const CLIENT_CONFIG_SERVER_STATUSES = ['live', 'maintenance', 'offline'] as const;

export const ClientConfigServerSchema = z.object({
  /** `live`, or `maintenance`/`offline` when an operator has taken the deployment down. */
  status: z.enum(CLIENT_CONFIG_SERVER_STATUSES),
  /** Public origin of this deployment, e.g. `https://app.bike4mind.com`. */
  app_url: z.string(),
  /** Address to show a user who needs help; `null` when the deployment has none configured. */
  support_email: z.string().nullable(),
});

/**
 * Deployment-wide availability of product features. `false` means the feature is switched
 * off for everyone; `true` means it is offered, not that this caller has opted in.
 */
export const ClientConfigFeaturesSchema = z.object({
  agents: z.boolean(),
  agent_mode: z.boolean(),
  artifacts: z.boolean(),
  data_lakes: z.boolean(),
  deep_research: z.boolean(),
  knowledge_base_search: z.boolean(),
  mcp_server: z.boolean(),
  custom_mcp_connectors: z.boolean(),
  mementos: z.boolean(),
  quest_master: z.boolean(),
  rapid_reply: z.boolean(),
  research_engine: z.boolean(),
  team_plan: z.boolean(),
  voice_sessions: z.boolean(),
});

export const ClientConfigLimitsSchema = z.object({
  /** Largest file upload the deployment accepts, in megabytes. */
  max_upload_size_mb: z.number().positive(),
  /** Whether calls are metered against a credit balance. Always `true` on hosted deployments. */
  credits_enforced: z.boolean(),
  /** Balance (in credits) under which a client should warn the user they are running low. */
  low_credits_threshold: z.number().nonnegative(),
});

export const ClientConfigModelsSchema = z.object({
  /** Model used when a request names none. May be absent from `available` if the caller cannot reach it. */
  default_id: z.string(),
  /** Admin-curated picks in display order, limited to models in `available`. */
  recommended_ids: z.array(z.string()),
  /** Every model the caller can use right now - the same list `GET /api/v1/models` pages through. */
  available: z.array(PublicModelSchema),
});

export const ClientConfigPublicSchema = z.object({
  api_url: z.string(),
  default_theme: z.string(),
  allow_open_registration: z.boolean(),
  pyodide_base_url: z.string(),
  allow_trusted_devices: z.boolean(),
  turnstile_site_key: z.string(),
  apple_sign_in_enabled: z.boolean(),
  support_email: z.string(),
});

export const ClientConfigPickerModelSchema = PublicModelSchema.extend({
  max_output_tokens_derived: z.boolean().optional(),
  thinking_style: z.enum(['legacy', 'adaptive']).optional(),
  thinking_always_on: z.literal(true).optional(),
  openai_reasoning_effort: z.literal(true).optional(),
  effort_incompatible_with_tools: z.boolean().optional(),
  supports_image_variation: z.boolean(),
  supports_safety_tolerance: z.boolean().optional(),
  training_cutoff: z.string().optional(),
  release_date: z.string().optional(),
  is_superseded: z.boolean().optional(),
  is_slow_model: z.boolean().optional(),
  disabled: z.boolean().optional(),
  disabled_reason: z.string().optional(),
  access: z.object({ locked: z.literal(true), reason: z.enum(['requires_paid_plan', 'org_policy']) }).optional(),
});

export const ClientConfigCatalogSchema = z.object({
  /** Includes disabled and speech-to-text entries, in legacy picker order. */
  models: z.array(ClientConfigPickerModelSchema),
  locked_models: z.array(ClientConfigPickerModelSchema),
  superseded_models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      replacement_id: z.string(),
      replacement_name: z.string(),
    })
  ),
  model_list_revision: z.string().nullable(),
  catalog_unavailable: z.boolean(),
});

export const ClientConfigResponseSchema = z.object({
  server: ClientConfigServerSchema,
  features: ClientConfigFeaturesSchema,
  limits: ClientConfigLimitsSchema,
  models: ClientConfigModelsSchema,
  public_config: ClientConfigPublicSchema.optional(),
  transport: z.object({ websocket_url: z.string(), sse_completions_url: z.string() }).optional(),
  catalog: ClientConfigCatalogSchema.optional(),
});

export type ClientConfigPublic = z.infer<typeof ClientConfigPublicSchema>;
export type ClientConfigPickerModel = z.infer<typeof ClientConfigPickerModelSchema>;
export type ClientConfigFeatures = z.infer<typeof ClientConfigFeaturesSchema>;
export type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;
