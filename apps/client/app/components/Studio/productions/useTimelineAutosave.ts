import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StudioTimelineSchema,
  validateStudioTimeline,
  type StudioTimeline,
  type StudioTimelineIssue,
  type StudioTimelineReferenceContext,
} from '@bike4mind/common';
import {
  compositionErrorIssues,
  compositionErrorMessage,
  useUpdateStudioComposition,
} from '@client/app/hooks/data/studioCompositions';

export const SAVE_DEBOUNCE_MS = 800;

/** A shared-validator issue, or a spec field the schema itself rejects (an empty caption, a negative time). */
export type TimelineEditorIssue = Omit<StudioTimelineIssue, 'code'> & {
  code: StudioTimelineIssue['code'] | 'invalid_spec';
};

export type TimelineSaveStatus =
  | { kind: 'saved' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'invalid'; issues: TimelineEditorIssue[] }
  | { kind: 'error'; message: string; issues: TimelineEditorIssue[] };

/** The spec's own checks, then the shared rules: the same two passes the server runs before it stores a timeline. */
export const timelineIssues = (
  timeline: StudioTimeline,
  context: StudioTimelineReferenceContext = {}
): TimelineEditorIssue[] => {
  const parsed = StudioTimelineSchema.safeParse(timeline);
  if (!parsed.success) {
    return parsed.error.issues.map(issue => ({
      code: 'invalid_spec' as const,
      path: issue.path.filter((key): key is string | number => typeof key !== 'symbol'),
      message: issue.message,
    }));
  }
  return validateStudioTimeline(parsed.data, context);
};

/**
 * Validates the editor's draft timeline on every edit and saves it after a short pause once it is valid; an invalid
 * draft waits until it is fixed. A save still pending when the editor unmounts is sent on the way out.
 * `stored` is the timeline as loaded, so an untouched draft never saves.
 */
export function useTimelineAutosave(
  compositionId: string,
  draft: StudioTimeline,
  stored: StudioTimeline,
  context: StudioTimelineReferenceContext
) {
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(stored));
  const update = useUpdateStudioComposition(compositionId);
  const draftJson = useMemo(() => JSON.stringify(draft), [draft]);
  const issues = useMemo(() => timelineIssues(draft, context), [draft, context]);
  const isDirty = draftJson !== savedJson;

  const save = useCallback(
    (timeline: StudioTimeline, json: string) => {
      update.mutate({ timeline }, { onSuccess: () => setSavedJson(json) });
    },
    // `mutate` is stable across renders; the mutation object itself is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update.mutate]
  );

  useEffect(() => {
    if (!isDirty || issues.length > 0) return;
    const handle = setTimeout(() => save(draft, draftJson), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, draftJson, isDirty, issues, save]);

  const pendingRef = useRef<{ draft: StudioTimeline; json: string } | null>(null);
  useEffect(() => {
    pendingRef.current = isDirty && issues.length === 0 ? { draft, json: draftJson } : null;
  }, [draft, draftJson, isDirty, issues]);
  useEffect(
    () => () => {
      if (pendingRef.current) save(pendingRef.current.draft, pendingRef.current.json);
    },
    [save]
  );

  const status = ((): TimelineSaveStatus => {
    if (issues.length > 0) return { kind: 'invalid', issues };
    if (update.isPending) return { kind: 'saving' };
    if (update.isError && isDirty) {
      return {
        kind: 'error',
        message: compositionErrorMessage(update.error),
        issues: compositionErrorIssues(update.error),
      };
    }
    return isDirty ? { kind: 'pending' } : { kind: 'saved' };
  })();

  return { issues, status };
}
