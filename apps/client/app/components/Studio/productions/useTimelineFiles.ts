import { useCallback, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  studioFileMediaKind,
  studioTimelineFileIds,
  type StudioFileMediaKind,
  type StudioTimeline,
  type StudioTimelineReferenceContext,
} from '@bike4mind/common';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';

/** What the editor and preview need of a Library file a clip references. */
export type TimelineFile = {
  id: string;
  fileName: string;
  mediaKind: StudioFileMediaKind;
  /** Signed on read; absent while the file is still loading or processing. */
  url: string | undefined;
};

/**
 * Resolves every file the timeline references to a playable URL and its media kind, through the per-file cache the
 * Library already fills. Source durations are learned from the media itself (FabFiles do not store one) and feed the
 * shared validator's trim check.
 */
export function useTimelineFiles(timeline: StudioTimeline) {
  const fileIds = useMemo(() => studioTimelineFileIds(timeline), [timeline]);
  // `combine` output is structurally shared, so `docs` keeps its identity until a file's data changes.
  const docs = useQueries({
    queries: fileIds.map(id => ({
      queryKey: fabFileKeys.doc(id),
      queryFn: () => getFabFileByIdFromServer(id),
    })),
    combine: results => results.map(result => result.data),
  });
  const [durationsMs, setDurationsMs] = useState<ReadonlyMap<string, number>>(new Map());

  const files = useMemo(() => {
    const map = new Map<string, TimelineFile>();
    docs.forEach((data, index) => {
      if (!data) return;
      map.set(fileIds[index], {
        id: fileIds[index],
        fileName: data.fileName,
        mediaKind: studioFileMediaKind(data.mimeType),
        url: data.presignedUrl ?? data.fileUrl,
      });
    });
    return map;
  }, [fileIds, docs]);

  const reportDuration = useCallback((fileId: string, durationMs: number) => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    setDurationsMs(previous => {
      if (previous.get(fileId) === Math.round(durationMs)) return previous;
      return new Map(previous).set(fileId, Math.round(durationMs));
    });
  }, []);

  const context = useMemo<StudioTimelineReferenceContext>(
    () => ({
      fileKinds: new Map([...files.values()].map(file => [file.id, file.mediaKind])),
      sourceDurationsMs: durationsMs,
    }),
    [files, durationsMs]
  );

  return { files, context, reportDuration };
}
