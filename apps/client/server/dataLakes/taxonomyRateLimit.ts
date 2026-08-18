/**
 * Shared daily OpenAI-spend budget for AI-taxonomy analysis, combining BOTH triggers into one
 * cap per user: the automatic post-upload analysis (`enqueueTaxonomyAnalysisIfWanted`) and the
 * manual re-analyze endpoint. Same bucket/key format the `rateLimit` Express middleware uses
 * (`rate-limit:<userId>:<bucket>`), so both paths draw from ONE counter - otherwise a user
 * could alternate uploads-with-AI-tagging and manual re-analyzes to exceed either cap alone.
 */
export const TAXONOMY_DAILY_CAP = 50;
export const TAXONOMY_RATE_LIMIT_BUCKET = 'data-lakes/reanalyze-taxonomy';
export const TAXONOMY_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const taxonomyRateLimitKey = (userId: string) => `rate-limit:${userId}:${TAXONOMY_RATE_LIMIT_BUCKET}`;
