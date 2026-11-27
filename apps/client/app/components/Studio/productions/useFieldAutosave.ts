import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { StudioCompositionContent, StudioCompositionUpdateBody } from '@bike4mind/common';
import {
  compositionErrorIssues,
  compositionErrorMessage,
  useUpdateStudioComposition,
} from '@client/app/hooks/data/studioCompositions';

export type AutosavedField = 'brief' | 'brandKit' | 'shots';

export const FIELD_AUTOSAVE_DELAY_MS = 600;

export type FieldSaveStatus =
  { kind: 'saved' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'error'; message: string };

/** Lets the editor know which fields hold unsaved edits, so closing the tab can ask first. */
export const FieldDirtyReporterContext = createContext<((field: AutosavedField, isDirty: boolean) => void) | null>(
  null
);

const saveErrorMessage = (error: unknown) =>
  compositionErrorIssues(error)[0]?.message ?? compositionErrorMessage(error);

/**
 * A local draft of one composition field that saves itself (PATCH replaces the field whole) shortly after the last
 * edit. Saves are queued, so an older draft never lands after a newer one. A failed draft is not retried while
 * mounted until it changes; on unmount an unsent or failed draft gets one more try (unless the server rejected its
 * content) and a failure toasts. The timeline has its own autosave (useTimelineAutosave) and never shares a PATCH
 * with these fields, so the two never overwrite each other.
 */
export function useFieldAutosave<Field extends AutosavedField>(
  compositionId: string,
  field: Field,
  initial: StudioCompositionContent[Field]
) {
  type Value = typeof initial;
  const [value, setValue] = useState<Value>(initial);
  const [saved, setSaved] = useState<Value>(initial);
  const [failure, setFailure] = useState<{ value: Value; message: string; isRejected: boolean } | null>(null);
  const [savingCount, setSavingCount] = useState(0);
  const { mutateAsync } = useUpdateStudioComposition(compositionId);
  const sentRef = useRef<Value | null>(null);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const enqueueSave = useCallback(
    (next: Value) => {
      sentRef.current = next;
      const run = queueRef.current.then(() => mutateAsync({ [field]: next } as StudioCompositionUpdateBody));
      queueRef.current = run.catch(() => undefined);
      return run;
    },
    [field, mutateAsync]
  );

  const isDirty = value !== saved;
  const isFailedDraft = failure?.value === value;

  useEffect(() => {
    if (!isDirty || isFailedDraft || value === sentRef.current) return;
    const timer = setTimeout(() => {
      setSavingCount(count => count + 1);
      enqueueSave(value)
        .then(
          () => setSaved(value),
          (error: unknown) => {
            if (sentRef.current === value) sentRef.current = null;
            setFailure({
              value,
              message: saveErrorMessage(error),
              isRejected: isAxiosError(error) && error.response?.status === 422,
            });
          }
        )
        .finally(() => setSavingCount(count => count - 1));
    }, FIELD_AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isDirty, isFailedDraft, value, enqueueSave]);

  const exitSaveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const isUnsent = isDirty && value !== sentRef.current;
    exitSaveRef.current =
      isUnsent && !(isFailedDraft && failure?.isRejected)
        ? () => {
            enqueueSave(value).catch((error: unknown) =>
              toast.error(`Your last edit was not saved: ${saveErrorMessage(error)}`)
            );
          }
        : null;
  });
  useEffect(() => () => exitSaveRef.current?.(), []);

  const reportDirty = useContext(FieldDirtyReporterContext);
  useEffect(() => {
    reportDirty?.(field, isDirty);
  }, [reportDirty, field, isDirty]);
  useEffect(() => () => reportDirty?.(field, false), [reportDirty, field]);

  const status = ((): FieldSaveStatus => {
    if (isFailedDraft && failure) return { kind: 'error', message: failure.message };
    if (savingCount > 0) return { kind: 'saving' };
    return isDirty ? { kind: 'pending' } : { kind: 'saved' };
  })();

  return { value, set: setValue, status, isDirty };
}
