export const API_KEY_USER_CAP_ERROR_CODE = 'api_key_user_cap';
export const API_KEY_TRUST_REQUIRED_ERROR_CODE = 'api_key_trust_required';
export const AGENT_LIMIT_REACHED_ERROR_CODE = 'agent_limit_reached';
export const UNKNOWN_MODEL_ERROR_CODE = 'unknown_model';
export const BILLING_ORGANIZATION_MISMATCH_ERROR_CODE = 'billing_organization_mismatch';
export const REQUEST_TIMEOUT_ERROR_CODE = 'request_timeout';

/**
 * The one enumerated vocabulary for the `errorCode` field on a public error body
 * (CONVENTIONS.md section 1, "One error-code vocabulary").
 *
 * Every classifier any endpoint emits lives here. Per-surface tuples narrow this
 * one - `QUEST_ERROR_CODES` for the SSE frame, `TTS_ERROR_CODES` for the audio
 * routes - and each declares `satisfies readonly ApiErrorCode[]`, so adding a code
 * to a narrower tuple without adding it here fails the build. That compiler link
 * is the whole point: the codes were two parallel unions sharing a field name
 * until they were folded together, and nothing structural stopped them drifting.
 *
 * Deliberately a leaf module with no imports: it is pulled in by contracts,
 * schemas, and `types/entities`, and any import here risks a cycle through the
 * barrel. Adding a classifier means adding it to this tuple, not inventing a
 * local one.
 */
export const API_ERROR_CODES = [
  /** The user must revoke an active API key or wait for one to expire before minting another. */
  API_KEY_USER_CAP_ERROR_CODE,
  /** The account is not yet trusted to mint (more) API keys; remediation is verifying email, waiting, purchasing or admin approval. */
  API_KEY_TRUST_REQUIRED_ERROR_CODE,
  /** The user owns as many agents as their tier allows; remediation is deleting one or upgrading. */
  AGENT_LIMIT_REACHED_ERROR_CODE,
  /** The caller cannot afford the request; remediation is buying credits. */
  'insufficient_credits',
  /** The owner is solvent but this key hit its admin-set ceiling; remediation is raising the cap. */
  'spend_cap_exceeded',
  /** WE have no usable key for the provider. Do not confuse with the next one. */
  'provider_not_configured',
  /** The provider REFUSED the key we sent. */
  'provider_rejected',
  /** The `model` is not one this caller can use; remediation is choosing an id from GET /api/v1/models. */
  UNKNOWN_MODEL_ERROR_CODE,
  /** An organization-billed API key named a different billing organization; remediation is omitting it. */
  BILLING_ORGANIZATION_MISMATCH_ERROR_CODE,
  /** A blocking request ran past its server-side deadline; the turn was ended and the body names it for polling. */
  REQUEST_TIMEOUT_ERROR_CODE,
  // Video generation (POST /api/v1/video-generations). Must stay in sync with VIDEO_GENERATION_API_ERROR_CODES.
  'unsupported_duration',
  'unsupported_aspect_ratio',
  'unsupported_resolution',
  'unsupported_mode',
  'missing_input_image',
  'unexpected_input_image',
  'unsupported_input_role',
  'unsupported_audio_option',
  'invalid_request',
  'model_disabled',
  'model_unavailable',
  'input_image_not_found',
  // Video job failure classifiers on the polled job resource; see VIDEO_JOB_PUBLIC_ERROR_CODES.
  'content_blocked',
  'provider_timeout',
  'provider_error',
  'region_unavailable',
  'output_too_large',
  'cancelled',
  'idempotency_key_reused',
  'invalid_idempotency_key',
  // Music generation (POST /api/v1/music-generations). Must stay in sync with MUSIC_GENERATION_API_ERROR_CODES;
  // the codes it shares with video are listed above.
  'unsupported_lyrics',
  'unsupported_vocals',
  'lyrics_with_instrumental',
  'lyrics_too_long',
  /** A cancel that arrived after the provider started (and so billed) the song; returned with a 409. */
  'not_cancellable',
  // Decisions (POST /api/v1/decisions); see DECISIONS_ERROR_CODES.
  /** The provider stayed overloaded or timed out through our one retry; the response carries Retry-After. */
  'provider_overloaded',
  /** The input exceeded the model's context window, as reported by the provider. */
  'context_length_exceeded',
  /** A request exceeded a per-model cap; `param` names the field and the message names the cap. */
  'limit_exceeded',
  /** The model cannot accept this input type (e.g. an image on a text-only model). */
  'unsupported_input',
  // Storage refusals on an upload; see STORAGE_ERROR_CODES.
  /** The upload would take the user's total storage past their limit; remediation is freeing space. */
  'storage_limit_exceeded',
  /** The upload is larger than the organization's storage limit. */
  'org_storage_limit_exceeded',
  /** The file is larger than the platform's per-file size limit. */
  'file_too_large',
  // Completions request errors (POST /api/ai/v1/completions).
  /** The selected model cannot continue a final assistant message. */
  'assistant_prefill_unsupported',
  /** A tool search server tool, `tool_reference` or tool search block was sent for a model that cannot serve it here. */
  'tool_search_unsupported',
  /** Every tool had `defer_loading: true` and no server tool was sent, so nothing would be loaded. */
  'all_tools_deferred',
  /** A deferred tool also carried `cache_control`, which the provider rejects. */
  'deferred_tool_cache_control',
  /** A `tool_reference` named a tool that is not in the request's `tools`. */
  'unknown_tool_reference',
  /** A `tool_addition` / `tool_removal` system message was sent for a model that cannot serve it here. */
  'tool_changes_unsupported',
  /** A tool change message was malformed or sat where the provider does not accept one. */
  'invalid_tool_change',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
