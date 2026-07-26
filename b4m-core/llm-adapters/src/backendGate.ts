import { ModelBackend } from '@bike4mind/common';

/**
 * Per-backend credentials as the caller's effective key table resolved them. A
 * missing or null value means "this caller has no key for that backend"; the
 * literal 'expired' sentinel is a key that getLlmByModel rejects loudly.
 */
export type ApiKeyTable = {
  [key in ModelBackend]?: string | null;
};

/**
 * What the deployment plus this caller can reach. Catalog rows describe what the
 * DEPLOYMENT's discovery credentials could see and are never a statement about
 * what a given caller may use, so the merge needs the same context the backend
 * fan-out has.
 */
export interface BackendGateContext {
  apiKeys: ApiKeyTable | null;
  /** B4M_SELF_HOST; gates the IMAGE_GEN_BASE_URL fallback in resolveListingKey. */
  isSelfHost: boolean;
}

/** Listing backends that take no credential: constructed unconditionally today. */
const KEYLESS_LISTING_BACKENDS: readonly string[] = [ModelBackend.Bedrock, ModelBackend.AWS];

/**
 * Backends with a listing constructor that takes a credential. VoyageAI is
 * deliberately absent: it has no entry in the getAvailableModels fan-out at all,
 * so no caller can list it and a catalog row naming it must fail closed.
 */
const KEYED_LISTING_BACKENDS: readonly string[] = [
  ModelBackend.OpenAI,
  ModelBackend.Anthropic,
  ModelBackend.Gemini,
  ModelBackend.Ollama,
  ModelBackend.BFL,
  ModelBackend.XAI,
  ModelBackend.LocalImage,
];

/**
 * The credential getAvailableModels constructs the listing backend for `backend`
 * with, or null when this context cannot construct one. The two special cases
 * live here rather than at the construction site so the seeded tier and the
 * catalog tier cannot disagree about who is reachable:
 *
 * - BFL always resolves (no key falls back to the demo key), matching
 *   `new BFLBackend('demo-key')` in both getAvailableModels and getLlmByModel.
 * - local-image falls back to IMAGE_GEN_BASE_URL only under self-host, so a
 *   hosted deploy that happens to set the var never enumerates free local models.
 */
export function resolveListingKey(backend: ModelBackend, ctx: BackendGateContext): string | null {
  if (backend === ModelBackend.BFL) return ctx.apiKeys?.bfl || 'demo-key';
  if (backend === ModelBackend.LocalImage) {
    const envUrl = ctx.isSelfHost ? process.env.IMAGE_GEN_BASE_URL : undefined;
    return ctx.apiKeys?.[ModelBackend.LocalImage] || envUrl || null;
  }
  return ctx.apiKeys?.[backend] || null;
}

/**
 * Can this context list models for `backend`? The single predicate both tiers of
 * getAvailableModels answer with - the seeded fan-out through resolveListingKey,
 * the catalog tier directly - so a catalog-only record can never be emitted to a
 * caller whose key table would not have produced its backend. Backends this
 * build cannot list fail closed.
 */
export function isBackendUsable(backend: string, ctx: BackendGateContext): boolean {
  if (KEYLESS_LISTING_BACKENDS.includes(backend)) return true;
  if (!KEYED_LISTING_BACKENDS.includes(backend)) return false;
  return resolveListingKey(backend as ModelBackend, ctx) !== null;
}
