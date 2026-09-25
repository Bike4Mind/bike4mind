import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getFabFilesFromServerByIds } from '@client/app/utils/filesAPICalls';
import useSessionLayout, {
  markModerationScanTimedOut,
  setPendingMessageFiles,
  type PendingMessageFile,
} from '@client/app/hooks/useSessionLayout';

export const MODERATION_POLL_INTERVAL_MS = 5_000;
export const MODERATION_SCAN_TIMEOUT_MS = 60_000;
/** After the timeout, a slow scan is still checked at this rate so a late clean result lands. */
export const MODERATION_SLOW_POLL_INTERVAL_MS = 15_000;
export const MODERATION_SLOW_POLL_WINDOW_MS = 10 * 60_000;

type ApplyResult = (fabFileId: string, moderationStatus: 'clean' | 'blocked', fileUrl?: string) => void;

const pollOnce = async (ids: string[], applyResult: ApplyResult, isCancelled: () => boolean) => {
  try {
    const files = await getFabFilesFromServerByIds(ids);
    if (isCancelled()) return;
    for (const file of files) {
      if (file.moderationStatus === 'clean' || file.moderationStatus === 'blocked') {
        applyResult(file.id, file.moderationStatus, file.fileUrl ?? undefined);
      }
    }
  } catch (error) {
    console.warn('Moderation status poll failed; will retry:', error);
  }
};

const idsWhere = (files: PendingMessageFile[], keep: (item: PendingMessageFile) => boolean) =>
  files
    .filter(keep)
    .map(item => item.fabFile.id)
    .join(',');

/**
 * Fallback for a lost `image_moderation_status` websocket event, which is otherwise the only
 * thing that clears an image's 'scanning' state (and with it the disabled Send button). While
 * any pending image is scanning, polls its server status and hands a clean/blocked result to
 * `applyResult`. An image still unconfirmed after MODERATION_SCAN_TIMEOUT_MS moves to 'error'
 * so Send is released, and is then re-checked slowly for MODERATION_SLOW_POLL_WINDOW_MS. It is
 * never made sendable here: only a server-confirmed clean result does that.
 */
export function useModerationScanFallback(pendingMessageFiles: PendingMessageFile[], applyResult: ApplyResult): void {
  const applyResultRef = useRef(applyResult);
  useEffect(() => {
    applyResultRef.current = applyResult;
  }, [applyResult]);

  // When each id was first seen scanning (ms).
  const scanningSinceRef = useRef(new Map<string, number>());
  // Timed-out ids still being re-checked, with the time to give up on each (ms). 'error' alone
  // can't identify them - a failed upload is 'error' too.
  const [slowPollUntil, setSlowPollUntil] = useState<Record<string, number>>({});

  // Keyed on the id sets so an unrelated pendingMessageFiles update doesn't restart an interval.
  const scanningKey = idsWhere(pendingMessageFiles, item => item.status === 'scanning');
  const slowKey = idsWhere(pendingMessageFiles, item => item.status === 'error' && item.fabFile.id in slowPollUntil);

  useEffect(() => {
    const since = scanningSinceRef.current;
    const ids = scanningKey ? scanningKey.split(',') : [];
    for (const id of [...since.keys()]) if (!ids.includes(id)) since.delete(id);
    if (ids.length === 0) return;
    const startedAt = Date.now();
    for (const id of ids) if (!since.has(id)) since.set(id, startedAt);

    let cancelled = false;
    const tick = async () => {
      await pollOnce(ids, applyResultRef.current, () => cancelled);
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
        setSlowPollUntil(prev => {
          const next = { ...prev };
          for (const id of timedOut) next[id] = now + MODERATION_SLOW_POLL_WINDOW_MS;
          return next;
        });
        toast.info(
          "An image's safety check is taking longer than usual. We're still checking - it will attach once it clears, or you can remove it."
        );
      }
    };

    const interval = setInterval(tick, MODERATION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [scanningKey]);

  useEffect(() => {
    const ids = slowKey ? slowKey.split(',') : [];
    if (ids.length === 0) return;

    let cancelled = false;
    const tick = async () => {
      const now = Date.now();
      const expired = ids.filter(id => (slowPollUntil[id] ?? 0) <= now);
      const live = ids.filter(id => !expired.includes(id));
      if (live.length > 0) await pollOnce(live, applyResultRef.current, () => cancelled);
      if (cancelled || expired.length === 0) return;
      setSlowPollUntil(prev => {
        const next = { ...prev };
        for (const id of expired) delete next[id];
        return next;
      });
    };

    const interval = setInterval(tick, MODERATION_SLOW_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [slowKey, slowPollUntil]);
}
