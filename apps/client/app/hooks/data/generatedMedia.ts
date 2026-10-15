import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@client/app/contexts/ApiContext';

// Server presigns for 3600s (GENERATED_MEDIA_URL_TTL_SECONDS); re-sign well before that so neither a
// re-mounted message nor a long-open tab (lazy audio/video, save/copy fetches) holds a dead URL.
const GENERATED_MEDIA_STALE_TIME_MS = 45 * 60 * 1000;
const GENERATED_MEDIA_GC_TIME_MS = GENERATED_MEDIA_STALE_TIME_MS;

const generatedMediaResponseSchema = z.object({
  urls: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});

const EMPTY_URLS: Record<string, string> = {};

export const generatedMediaKeys = {
  urls: (sessionId: string | undefined, keys: string[]) => ['generatedMediaUrls', sessionId, keys] as const,
};

/**
 * Resolves bare generated-media keys to short-lived presigned URLs via the authorized endpoint.
 * Keys the caller may not read are absent from `urls`; callers must skip those entries.
 */
export function useGeneratedMediaUrls(sessionId: string | undefined, keys: string[]) {
  const normalizedKeys = [...new Set(keys)].sort();

  const query = useQuery({
    queryKey: generatedMediaKeys.urls(sessionId, normalizedKeys),
    queryFn: async () => {
      const { data } = await api.post(`/api/sessions/${sessionId}/generated-media`, { keys: normalizedKeys });
      return generatedMediaResponseSchema.parse(data);
    },
    enabled: Boolean(sessionId) && normalizedKeys.length > 0,
    staleTime: GENERATED_MEDIA_STALE_TIME_MS,
    gcTime: GENERATED_MEDIA_GC_TIME_MS,
    refetchInterval: GENERATED_MEDIA_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    // A streaming turn adds keys one at a time; keep the already-signed ones on screen meanwhile.
    placeholderData: keepPreviousData,
  });

  return { urls: query.data?.urls ?? EMPTY_URLS, isLoading: query.isLoading };
}
