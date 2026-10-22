/**
 * The single registry for every music-generation react-query key (mirrors videoGenerationKeys.ts). Never write one
 * of these keys as a literal outside this file. Every write into a detail goes through musicGenerationCache.ts.
 *
 * - `list` is the Studio gallery's infinite query (GET /api/v1/music-generations); its pages seed `detail(id)`.
 */
export const musicGenerationKeys = {
  all: ['musicGenerations'] as const,
  models: ['musicGenerations', 'models'] as const,
  list: ['musicGenerations', 'list'] as const,
  details: ['musicGenerations', 'detail'] as const,
  detail: (id: string) => ['musicGenerations', 'detail', id] as const,
};
