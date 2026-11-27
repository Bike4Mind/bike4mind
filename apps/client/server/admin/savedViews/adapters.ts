import { adminSavedViewRepository } from '@bike4mind/database';
import type { SavedViewsDeps, SavedViewsLogger } from './savedViews';

/** Shared by both saved-views routes: one per-admin budget for reads and writes together. */
export const SAVED_VIEWS_RATE_LIMIT = { limit: 60, windowMs: 60_000, bucket: 'admin-saved-views' };

export const savedViewsDeps = (logger?: SavedViewsLogger): SavedViewsDeps => ({
  repository: adminSavedViewRepository,
  logger,
});
