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
  /** The caller cannot afford the request; remediation is buying credits. */
  'insufficient_credits',
  /** The owner is solvent but this key hit its admin-set ceiling; remediation is raising the cap. */
  'spend_cap_exceeded',
  /** WE have no usable key for the provider. Do not confuse with the next one. */
  'provider_not_configured',
  /** The provider REFUSED the key we sent. */
  'provider_rejected',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
