/**
 * getAvailableModels options shared by /api/models and any route that must observe the same
 * catalog it does. getModelCacheKey folds these fields into the module cache key, so a route
 * that differs on any of them gets its own cache slot and can observe a different list -- the
 * drift that hand-maintained model lists used to cause.
 *
 * isSelfHost is read per call because the flag is environment state, not a build-time constant.
 */
const BACKEND_TIMEOUT_MS = 2_000;

export function modelCatalogListingOptions() {
  return {
    perBackendTimeoutMs: BACKEND_TIMEOUT_MS,
    // The picker is the one consumer that must not see private models; every
    // other getAvailableModels caller resolves pinned private models by id.
    includePrivate: false,
    isSelfHost: process.env.B4M_SELF_HOST === 'true',
  };
}
