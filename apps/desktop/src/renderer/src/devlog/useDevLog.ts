import { useCallback, useEffect, useRef, useState } from 'react';
import type { DevLogRecord } from '@shared/devLog';
import { compareTags, mergeRecords } from './devLogView';

/** Coalescing fallback for a window the compositor has stopped giving frames to. */
const FLUSH_FALLBACK_MS = 250;

export interface DevLogFeed {
  records: DevLogRecord[];
  /** Every tag seen so far, in filter-bar order. Open set: nothing here lists the known tags. */
  tags: string[];
  dropped: number;
  clear: () => void;
}

/**
 * The live tail.
 *
 * Main already coalesces into batches; this folds those batches once per frame on top, so a
 * burst that spans several batches still costs one render. The tag set is maintained as records
 * arrive rather than recomputed from the buffer, so the filter bar costs nothing per batch.
 */
export function useDevLog(): DevLogFeed {
  const [records, setRecords] = useState<DevLogRecord[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [dropped, setDropped] = useState(0);
  const seenTags = useRef(new Set<string>());

  const noteTags = useCallback((incoming: readonly DevLogRecord[]) => {
    let added = false;
    for (const record of incoming) {
      for (const tag of record.tags) {
        if (seenTags.current.has(tag)) continue;
        seenTags.current.add(tag);
        added = true;
      }
    }
    if (added) setTags([...seenTags.current].sort(compareTags));
  }, []);

  useEffect(() => {
    let pending: DevLogRecord[] = [];
    let frame: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
      frame = undefined;
      fallback = undefined;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      noteTags(batch);
      setRecords(current => mergeRecords(current, batch));
    };

    const unsubscribe = window.b4m.devLog.onRecords(incoming => {
      pending.push(...incoming);
      frame ??= requestAnimationFrame(flush);
      fallback ??= setTimeout(flush, FLUSH_FALLBACK_MS);
    });

    void window.b4m.devLog.getSnapshot().then(snapshot => {
      noteTags(snapshot.records);
      setDropped(snapshot.dropped);
      setRecords(current => mergeRecords(current, snapshot.records));
    });

    return () => {
      unsubscribe();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
    };
  }, [noteTags]);

  const clear = useCallback(() => {
    seenTags.current = new Set();
    setTags([]);
    setRecords([]);
    setDropped(0);
    void window.b4m.devLog.clear();
  }, []);

  return { records, tags, dropped, clear };
}
