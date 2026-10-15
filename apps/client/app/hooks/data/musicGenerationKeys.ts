/**
 * The single registry for every music-generation react-query key (mirrors videoGenerationKeys.ts). Never write one
 * of these keys as a literal outside this file. Every write into a detail goes through musicGenerationCache.ts.
 */
export const musicGenerationKeys = {
  all: ['musicGenerations'] as const,
  details: ['musicGenerations', 'detail'] as const,
  detail: (id: string) => ['musicGenerations', 'detail', id] as const,
};
