/**
 * The single registry for every video-generation react-query key (mirrors fabFileKeys.ts). Never write one of
 * these keys as a literal outside this file; the parity test is the one exception.
 *
 * - `all` prefixes everything below.
 * - `details` prefixes every `detail(id)`. Every write into a detail goes through videoGenerationCache.ts.
 * - `list` is the gallery's infinite query (GET /api/v1/video-generations); its pages seed `detail(id)`.
 */
export const videoGenerationKeys = {
  all: ['videoGenerations'] as const,
  models: ['videoGenerations', 'models'] as const,
  list: ['videoGenerations', 'list'] as const,
  details: ['videoGenerations', 'detail'] as const,
  detail: (id: string) => ['videoGenerations', 'detail', id] as const,
};
