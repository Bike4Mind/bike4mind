import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { getFabFilesFromServerByIds } from '@client/app/utils/filesAPICalls';
import useSessionLayout, {
  markModerationScanTimedOut,
  setPendingMessageFiles,
  type PendingMessageFile,
} from '@client/app/hooks/useSessionLayout';

export const MODERATION_POLL_INTERVAL_MS = 5_000;
export const MODERATION_SCAN_TIMEOUT_MS = 60_000;

/**
 * Fallback for a lost `image_moderation_status` websocket event, which is otherwise the only
 * thing that clears an image's 'scanning' state (and with it the disabled Send button). While
 * any pending image is scanning, polls its server status and hands a clean/blocked result to
 * `applyResult`. An image still unconfirmed after MODERATION_SCAN_TIMEOUT_MS moves to 'error'
 * - never to sendable - so the user can remove it and retry.
 */
export function useModerationScanFallback(
  pendingMessageFiles: PendingMessageFile[],
  applyResult: (fabFileId: string, moderationStatus: 'clean' | 'blocked', fileUrl?: string) => void
): void {
  const applyResultRef = useRef(applyResult);
  useEffect(() => {
    applyResultRef.current = applyResult;
  }, [applyResult]);

  // When each id was first seen scanning (ms).
  const scanningSinceRef = useRef(new Map<string, number>());

  // Keyed on the id set so an unrelated pendingMessageFiles update doesn't restart the interval.
  const scanningKey = pendingMessageFiles
    .filter(item => item.status === 'scanning')
    .map(item => item.fabFile.id)
    .join(',');

  useEffect(() => {
    const since = scanningSinceRef.current;
    const ids = scanningKey ? scanningKey.split(',') : [];
    for (const id of [...since.keys()]) if (!ids.includes(id)) since.delete(id);
    if (ids.length === 0) return;
    const startedAt = Date.now();
    for (const id of ids) if (!since.has(id)) since.set(id, startedAt);

    let cancelled = false;
    const tick = async () => {
      try {
        const files = await getFabFilesFromServerByIds(ids);
        if (cancelled) return;
        for (const file of files) {
          if (file.moderationStatus === 'clean' || file.moderationStatus === 'blocked') {
            applyResultRef.current(file.id, file.moderationStatus, file.fileUrl ?? undefined);
          }
        }
      } catch (error) {
        console.warn('Moderation status poll failed; will retry:', error);
      }
      if (cancelled) return;

      const now = Date.now();
      const stillScanning = new Set(
        useSessionLayout
          .getState()
          .pendingMessageFiles.filter(item => item.status === 'scanning')
          .map(item => item.fabFile.id)
      );
      const timedOut = ids.filter(
        id => stillScanning.has(id) && now - (since.get(id) ?? now) >= MODERATION_SCAN_TIMEOUT_MS
      );
      if (timedOut.length > 0) {
        setPendingMessageFiles(prev => markModerationScanTimedOut(prev, timedOut));
        toast.error("An image's safety check is taking too long. Remove it and try attaching it again.");
      }
    };

    const interval = setInterval(tick, MODERATION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [scanningKey]);
}
