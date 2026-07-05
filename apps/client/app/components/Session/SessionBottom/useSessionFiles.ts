import { useEffect, useRef, useState } from 'react';

import useSessionLayout, { setPendingMessageFiles } from '@client/app/hooks/useSessionLayout';

/**
 * Manages FilePond file state and clears it when the active session changes.
 *
 * Returns:
 * - files / setFiles: FilePond internal file list (any[] - FilePond has no proper TS generics)
 * - clearFiles: imperative helper to empty the FilePond list after a message send
 */
export function useSessionFiles(currentSessionId: string | null): {
  // any: FilePond file objects have no stable public type definition
  files: any[];
  setFiles: React.Dispatch<React.SetStateAction<any[]>>;
  clearFiles: () => void;
} {
  // any: FilePond file objects have no stable public type definition
  const [files, setFiles] = useState<any[]>([]);
  const previousSessionIdRef = useRef<string | null>(null);
  const pendingMessageFilesLength = useSessionLayout(s => (s.pendingMessageFiles ?? []).length);

  useEffect(() => {
    if (previousSessionIdRef.current !== null && previousSessionIdRef.current !== currentSessionId) {
      if (files.length > 0) {
        setFiles([]);
      }
      if (pendingMessageFilesLength > 0) {
        setPendingMessageFiles([]);
      }
    }
    previousSessionIdRef.current = currentSessionId;
  }, [currentSessionId, files.length, pendingMessageFilesLength]);

  const clearFiles = () => setFiles([]);

  return { files, setFiles, clearFiles };
}
