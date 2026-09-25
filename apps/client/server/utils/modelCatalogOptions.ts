import { PICKER_LISTING_OPTIONS } from '@bike4mind/llm-adapters';

/**
 * getAvailableModels options shared by /api/models and any route that must observe the same
 * catalog it does. getModelCacheKey folds these fields into the module cache key, so a route
 * that differs on any of them gets its own cache slot and can observe a different list -- the
 * drift that hand-maintained model lists used to cause.
 *
 * isSelfHost is read per call because the flag is environment state, not a build-time constant.
 */
export function modelCatalogListingOptions() {
  return {
    // Shared with the Slack model dropdowns; the pickers are the consumers that must
    // not see private models, while every other caller resolves them by id.
    ...PICKER_LISTING_OPTIONS,
    isSelfHost: process.env.B4M_SELF_HOST === 'true',
  };
}
