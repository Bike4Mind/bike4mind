/**
 * The query-embedding rate limit for data-lake semantic search, shared by POST
 * /api/data-lakes/semantic-search and POST /api/v1/data-lakes/{id}/search. Both name the same
 * bucket, so a caller gets one budget across the two doors rather than double the embedding spend
 * the limit exists to cap. The public contract documents the production figure (10/min).
 */
export const SEMANTIC_SEARCH_RATE_LIMIT = {
  limit: process.env.NODE_ENV === 'development' ? 100 : 10,
  windowMs: 60 * 1000,
  bucket: '/api/data-lakes/semantic-search',
};
