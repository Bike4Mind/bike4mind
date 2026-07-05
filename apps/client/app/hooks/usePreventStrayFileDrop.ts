import { useEffect } from 'react';

/**
 * Suppresses the browser default (open-file-in-new-tab) for OS-file drags that land
 * outside a registered drop zone. Component drop zones (e.g. DataLakeExplorer, the chat
 * dock) still run their own handlers and preventDefault themselves; this document-level
 * listener is only a catch-all so stray drops on non-drop-zone regions (side nav, gutters)
 * are ignored instead of navigating.
 *
 * Both `dragover` and `drop` must be prevented - the browser only fires a drop if the
 * preceding `dragover` was prevented. Only file drags are touched, so in-app element
 * drags (e.g. useDraggable) are left alone.
 */
export function usePreventStrayFileDrop(): void {
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const suppress = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    document.addEventListener('dragover', suppress);
    document.addEventListener('drop', suppress);
    return () => {
      document.removeEventListener('dragover', suppress);
      document.removeEventListener('drop', suppress);
    };
  }, []);
}
