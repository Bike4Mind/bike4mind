import { useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@client/app/contexts/ApiContext';

// Re-sign this long before the server's expiresAt, so neither a re-mounted message nor a long-open
// tab (lazy audio/video, save/copy/edit fetches) holds a dead URL. Must exceed the default 5 min
// gcTime, so a cache entry revived on remount is always still valid while it refetches.
const GENERATED_MEDIA_REFRESH_MARGIN_MS = 15 * 60 * 1000;
const GENERATED_MEDIA_MIN_REFRESH_MS = 60 * 1000;
// A key can reach the client before the stored quest records it, and the server omits it until
// then. Retry briefly instead of caching the gap until the next re-sign; capped, because a key the
// caller may not read is omitted for good. 5 x 4s outlasts the ~10s streaming heartbeat save.
const MISSING_KEY_RETRY_MS = 4 * 1000;
const MISSING_KEY_MAX_RETRIES = 5;

const generatedMediaResponseSchema = z.object({
  urls: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});

type GeneratedMediaResponse = z.infer<typeof generatedMediaResponseSchema>;
type SignedUrl = { url: string; expiresAtMs: number };
// missingKeyRetries: consecutive responses so far, for this key set, that omitted a requested key.
type GeneratedMediaUrls = GeneratedMediaResponse & { missingKeyRetries: number };

const EMPTY_URLS: Record<string, string> = {};

export const generatedMediaKeys = {
  urls: (sessionId: string | undefined, keys: string[]) => ['generatedMediaUrls', sessionId, keys] as const,
};

const msUntilRefresh = (data: GeneratedMediaUrls | undefined): number => {
  if (!data) return 0;
  if (data.missingKeyRetries > 0 && data.missingKeyRetries <= MISSING_KEY_MAX_RETRIES) return MISSING_KEY_RETRY_MS;
  const refreshAt = Date.parse(data.expiresAt) - GENERATED_MEDIA_REFRESH_MARGIN_MS;
  return Math.max(refreshAt - Date.now(), GENERATED_MEDIA_MIN_REFRESH_MS);
};

/**
 * Keep a key's previous URL while it is still fresh. Each response re-signs every key in the turn,
 * and a changed src reloads an <img>, restarts <audio>, and re-downloads a video mid-play.
 */
const mergeStableUrls = (
  previous: Record<string, SignedUrl>,
  response: GeneratedMediaResponse
): Record<string, SignedUrl> => {
  const expiresAtMs = Date.parse(response.expiresAt);
  const keepUntil = Date.now() + GENERATED_MEDIA_REFRESH_MARGIN_MS;
  return Object.fromEntries(
    Object.entries(response.urls).map(([key, url]) => {
      const kept = previous[key];
      return [key, kept && kept.expiresAtMs > keepUntil ? kept : { url, expiresAtMs }];
    })
  );
};

// Held URLs can be older than this response, so the refresh is scheduled off the earliest expiry.
const toResponse = (held: Record<string, SignedUrl>, response: GeneratedMediaResponse): GeneratedMediaResponse => {
  const earliestExpiryMs = Math.min(
    Date.parse(response.expiresAt),
    ...Object.values(held).map(entry => entry.expiresAtMs)
  );
  return {
    urls: Object.fromEntries(Object.entries(held).map(([key, entry]) => [key, entry.url])),
    expiresAt: new Date(earliestExpiryMs).toISOString(),
  };
};

/**
 * Resolves bare generated-media keys to short-lived presigned URLs via the authorized endpoint
 * (GET /api/sessions/[id]/generated-media). Keys the caller may not read are absent from `urls`;
 * callers must skip those entries.
 */
export function useGeneratedMediaUrls(sessionId: string | undefined, keys: string[]) {
  const normalizedKeys = [...new Set(keys)].sort();
  // Read and written only inside queryFn: URLs held from earlier responses of this message.
  const heldUrlsRef = useRef<Record<string, SignedUrl>>({});
  // Read and written only inside queryFn: the missing-key retry count, scoped to one key set.
  const missingKeyRetriesRef = useRef<{ keySet: string; retries: number }>({ keySet: '', retries: 0 });

  const query = useQuery({
    queryKey: generatedMediaKeys.urls(sessionId, normalizedKeys),
    queryFn: async (): Promise<GeneratedMediaUrls> => {
      // GET, not POST: this is a read, and a read-only session view may refuse writes to the session.
      const params = new URLSearchParams(normalizedKeys.map(key => ['keys', key]));
      const { data } = await api.get(`/api/sessions/${sessionId}/generated-media?${params.toString()}`);
      const response = generatedMediaResponseSchema.parse(data);
      const held = mergeStableUrls(heldUrlsRef.current, response);
      heldUrlsRef.current = held;

      const keySet = params.toString();
      const isMissingKey = normalizedKeys.some(key => !(key in response.urls));
      const previousRetries = missingKeyRetriesRef.current.keySet === keySet ? missingKeyRetriesRef.current.retries : 0;
      const missingKeyRetries = isMissingKey ? previousRetries + 1 : 0;
      missingKeyRetriesRef.current = { keySet, retries: missingKeyRetries };

      return { ...toResponse(held, response), missingKeyRetries };
    },
    enabled: Boolean(sessionId) && normalizedKeys.length > 0,
    // Fresh until the refresh point: a remount or refocus inside it costs nothing, and one past it
    // (including a tab that was hidden through the interval tick) re-signs.
    staleTime: query => msUntilRefresh(query.state.data),
    refetchInterval: query => (query.state.data ? msUntilRefresh(query.state.data) : false),
    // A streaming turn adds keys one at a time; keep the already-signed ones on screen meanwhile.
    placeholderData: keepPreviousData,
  });

  return { urls: query.data?.urls ?? EMPTY_URLS, isLoading: query.isLoading };
}
