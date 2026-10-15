/**
 * UI helpers shared by every generation-job card (video, music). Kind-specific labels stay with each card; the
 * state color mapping and the player-URL dance are identical across kinds, so they live here instead of being
 * copied into each card (or imported across feature boundaries).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColorPaletteProp } from '@mui/joy';
import type { GenerationJobState } from '@bike4mind/common';

export const STATE_COLORS: Record<GenerationJobState, ColorPaletteProp> = {
  pending: 'neutral',
  running: 'primary',
  storing: 'primary',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'warning',
  cancelled: 'neutral',
};

// A refreshed URL that fails again (the file was removed or blocked) must not loop.
export const MAX_PLAYER_URL_REFRESHES = 2;

/**
 * Re-signing (every ~14 minutes) must not restart a clip mid-play: keep the URL the player started with until the
 * element reports an error, then take the newest URL, asking for a fresh one at most MAX_PLAYER_URL_REFRESHES times.
 */
export function useStablePlayerSrc(latestUrl: string | null, refresh: () => void) {
  const [src, setSrc] = useState<string | null>(latestUrl);
  const [awaitingFresh, setAwaitingFresh] = useState(false);
  const refreshes = useRef(0);

  useEffect(() => {
    if (src === null && latestUrl) {
      setSrc(latestUrl);
      return;
    }
    if (awaitingFresh && latestUrl && latestUrl !== src) {
      setSrc(latestUrl);
      setAwaitingFresh(false);
    }
  }, [latestUrl, src, awaitingFresh]);

  const onError = useCallback(() => {
    if (latestUrl && latestUrl !== src) {
      setSrc(latestUrl);
      return;
    }
    if (refreshes.current >= MAX_PLAYER_URL_REFRESHES) return;
    refreshes.current += 1;
    setAwaitingFresh(true);
    refresh();
  }, [latestUrl, src, refresh]);

  const onLoaded = useCallback(() => {
    refreshes.current = 0;
  }, []);

  return { src, onError, onLoaded };
}
