import { useCallback, useEffect, useRef, useState } from 'react';

export interface FileDropState {
  /** True while a drag carrying files is over the window, for the overlay. */
  over: boolean;
  /** Spread onto the element that should accept the drop. */
  handlers: {
    onDragEnter: (event: React.DragEvent) => void;
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
}

function carriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Files dragged onto the window.
 *
 * Every handler calls preventDefault on a file drag, including the ones that do nothing else:
 * without it Chromium NAVIGATES the window to the dropped file, which in an Electron app
 * replaces the running renderer with a picture and loses the conversation.
 *
 * The enter/leave pair is counted rather than toggled, because dragging across a child element
 * fires leave-then-enter and a boolean would flicker the overlay off on every internal border.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean): FileDropState {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  // A drop anywhere outside the target still navigates the window, so the document as a whole
  // has to refuse it - the drop zone is only where a drop MEANS something.
  useEffect(() => {
    const swallow = (event: DragEvent) => event.preventDefault();
    document.addEventListener('dragover', swallow);
    document.addEventListener('drop', swallow);
    return () => {
      document.removeEventListener('dragover', swallow);
      document.removeEventListener('drop', swallow);
    };
  }, []);

  const onDragEnter = useCallback(
    (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      if (enabled) setOver(true);
    },
    [enabled]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      if (!enabled) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [enabled, onFiles]
  );

  return { over, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
