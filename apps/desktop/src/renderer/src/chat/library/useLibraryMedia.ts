import { useEffect, useState } from 'react';
import type { LibraryApi, LibraryItemRef, LibraryMedia } from '@shared/library';
import { describeLibraryError } from './useLibraryFeed';

export type MediaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; media: LibraryMedia }
  | { status: 'error'; message: string };

/** One item's local copy, fetched once when `enabled` turns on. Main caches it for the run. */
export function useLibraryMedia(
  api: Pick<LibraryApi, 'media'>,
  ref: LibraryItemRef | null,
  enabled: boolean
): MediaState & { retry: () => void } {
  const [state, setState] = useState<MediaState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const medium = ref?.medium;
  const id = ref?.id;
  useEffect(() => {
    if (!enabled || !medium || !id) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    api.media({ medium, id }).then(
      media => live && setState({ status: 'ready', media }),
      (error: unknown) => live && setState({ status: 'error', message: describeLibraryError(error) })
    );
    return () => {
      live = false;
    };
  }, [api, medium, id, enabled, attempt]);
  return { ...state, retry: () => setAttempt(value => value + 1) };
}
