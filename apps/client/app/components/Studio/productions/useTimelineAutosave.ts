import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StudioTimelineSchema,
  validateStudioTimeline,
  type StudioTimeline,
  type StudioTimelineIssue,
  type StudioTimelineReferenceContext,
} from '@bike4mind/common';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
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
 * draft waits until it is fixed. Saves go out one at a time, so an older draft can never land after a newer one.
 * A save still pending when the editor unmounts is sent on the way out, retrying a draft whose save failed for any
 * reason but a 422 once. `blocksNavigation` is true while unsaved edits could not go out that way (an invalid or
 * rejected draft); the editor guards in-app navigation on it. `stored` is the timeline as loaded, so an untouched
 * draft never saves.
 */
export function useTimelineAutosave(
  compositionId: string,
  draft: StudioTimeline,
  stored: StudioTimeline,
  context: StudioTimelineReferenceContext
) {
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(stored));
  // The draft whose save last failed: not retried while mounted until it changes, so a 422 or an outage cannot loop.
  const [failed, setFailed] = useState<{ json: string; isRejected: boolean } | null>(null);
  const { mutateAsync, isPending, isError, error } = useUpdateStudioComposition(compositionId);
  const draftJson = useMemo(() => JSON.stringify(draft), [draft]);
  const issues = useMemo(() => timelineIssues(draft, context), [draft, context]);
  const isDirty = draftJson !== savedJson;
  const isFailedDraft = draftJson === failed?.json;
  const canSave = isDirty && issues.length === 0 && !isFailedDraft;
  // On the way out a failed draft gets one more try, unless the server rejected its content.
  const canSaveOnExit = isDirty && issues.length === 0 && !(isFailedDraft && failed?.isRejected);

  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueSave = useCallback(
    (timeline: StudioTimeline) => {
      const run = queueRef.current.then(() => mutateAsync({ timeline }));
      queueRef.current = run.catch(() => undefined);
      return run;
    },
    [mutateAsync]
  );

  useEffect(() => {
    if (!canSave || isPending) return;
    const handle = setTimeout(() => {
      enqueueSave(draft).then(
        () => setSavedJson(draftJson),
        (saveError: unknown) =>
          setFailed({ json: draftJson, isRejected: isAxiosError(saveError) && saveError.response?.status === 422 })
      );
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [canSave, isPending, draft, draftJson, enqueueSave]);

  const exitSaveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    exitSaveRef.current = canSaveOnExit
      ? () => {
          enqueueSave(draft).catch((exitError: unknown) =>
            toast.error(`Your last edit was not saved: ${compositionErrorMessage(exitError)}`)
          );
        }
      : null;
  }, [canSaveOnExit, draft, enqueueSave]);
  useEffect(() => () => exitSaveRef.current?.(), []);

  const status = ((): TimelineSaveStatus => {
    if (issues.length > 0) return { kind: 'invalid', issues };
    if (isPending) return { kind: 'saving' };
    if (isError && isDirty) {
      return { kind: 'error', message: compositionErrorMessage(error), issues: compositionErrorIssues(error) };
    }
    return isDirty ? { kind: 'pending' } : { kind: 'saved' };
  })();

  return { issues, status, isDirty, blocksNavigation: isDirty && !canSaveOnExit };
}
