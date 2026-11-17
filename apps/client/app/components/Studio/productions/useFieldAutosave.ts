import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioCompositionUpdateBody } from '@bike4mind/common';
import {
  compositionErrorIssues,
  compositionErrorMessage,
  useUpdateStudioComposition,
} from '@client/app/hooks/data/studioCompositions';

export type AutosavedField = 'brief' | 'brandKit' | 'shots';

export const FIELD_AUTOSAVE_DELAY_MS = 600;

export type FieldSaveStatus = { kind: 'saved' } | { kind: 'saving' } | { kind: 'error'; message: string };

/**
 * A local draft of one composition field that saves itself (PATCH replaces the field whole) shortly after the last
 * edit, and on unmount when an edit is still waiting. The timeline has its own autosave (useTimelineAutosave); the
 * fields never share a PATCH, so the two never overwrite each other.
 */
export function useFieldAutosave<Field extends AutosavedField>(
  compositionId: string,
  field: Field,
  initial: NonNullable<StudioCompositionUpdateBody[Field]>
) {
  type Value = typeof initial;
  const [value, setValue] = useState<Value>(initial);
  const [status, setStatus] = useState<FieldSaveStatus>({ kind: 'saved' });
  const update = useUpdateStudioComposition(compositionId);
  const savedRef = useRef<Value>(initial);
  const pendingRef = useRef<Value | null>(null);
  const mutateRef = useRef(update.mutate);
  useEffect(() => {
    mutateRef.current = update.mutate;
  }, [update.mutate]);

  const save = useCallback(
    (next: Value) => {
      pendingRef.current = null;
      setStatus({ kind: 'saving' });
      mutateRef.current({ [field]: next } as StudioCompositionUpdateBody, {
        onSuccess: () => {
          savedRef.current = next;
          setStatus({ kind: 'saved' });
        },
        onError: error => {
          const [issue] = compositionErrorIssues(error);
          setStatus({ kind: 'error', message: issue?.message ?? compositionErrorMessage(error) });
        },
      });
    },
    [field]
  );

  useEffect(() => {
    if (value === savedRef.current) return;
    pendingRef.current = value;
    const timer = setTimeout(() => save(value), FIELD_AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value, save]);

  // An edit still inside the debounce window is sent as the editor unmounts rather than dropped.
  useEffect(
    () => () => {
      if (pendingRef.current !== null) save(pendingRef.current);
    },
    [save]
  );

  return { value, set: setValue, status };
}
