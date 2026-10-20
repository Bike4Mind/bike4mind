import { useCallback, useEffect, useRef, useState } from 'react';
import { useGetPresignedUrl } from '@client/app/hooks/data/fabFiles';
import { storageKeyOf } from './whatsNewSlideMedia';

const SIGNED_URL_TTL_SECONDS = 3600;
const MIN_REFRESH_INTERVAL_MS = 30_000;

/** Stored URL -> playable URL; undefined while resolving, null when the server withheld it. */
export type ResolvedMediaUrls = Record<string, string | null>;

/**
 * Resolves modal media URLs for playback. A stored upload is presigned like slide images; `refresh`
 * re-signs one URL so a looping video recovers when its signature expires mid-session. It returns false
 * when there is nothing to retry (an unsigned URL, or one already re-signed in the last 30s).
 */
export function useSignedMediaUrls(urls: string[]) {
  const { mutateAsync: sign } = useGetPresignedUrl();

  const [resolved, setResolved] = useState<ResolvedMediaUrls>({});
  const lastRefresh = useRef(new Map<string, number>());

  const urlsKey = Array.from(new Set(urls)).join('\n');

  const resolve = useCallback(
    async (targets: string[]): Promise<ResolvedMediaUrls> => {
      const out: ResolvedMediaUrls = {};
      const stored: { url: string; key: string }[] = [];
      for (const url of targets) {
        const key = storageKeyOf(url);
        if (key) stored.push({ url, key });
        else out[url] = url;
      }
      if (stored.length === 0) return out;
      try {
        const signed = await sign({
          filePaths: stored.map(s => s.key),
          expiresIn: SIGNED_URL_TTL_SECONDS,
        });
        stored.forEach(({ url }, i) => {
          out[url] = signed[i] ?? null;
        });
      } catch {
        stored.forEach(({ url }) => {
          out[url] = null;
        });
      }
      return out;
    },
    [sign]
  );

  useEffect(() => {
    if (!urlsKey) return;
    let cancelled = false;
    void resolve(urlsKey.split('\n')).then(next => {
      if (!cancelled) setResolved(prev => ({ ...prev, ...next }));
    });
    return () => {
      cancelled = true;
    };
  }, [urlsKey, resolve]);

  const refresh = useCallback(
    (url: string): boolean => {
      if (!storageKeyOf(url)) return false;
      const now = Date.now();
      if (now - (lastRefresh.current.get(url) ?? 0) < MIN_REFRESH_INTERVAL_MS) return false;
      lastRefresh.current.set(url, now);
      void resolve([url]).then(next => {
        // A failed re-sign keeps the old URL rather than tearing down a video that may still be buffered
        if (next[url]) setResolved(prev => ({ ...prev, ...next }));
      });
      return true;
    },
    [resolve]
  );

  return { resolved, refresh };
}
