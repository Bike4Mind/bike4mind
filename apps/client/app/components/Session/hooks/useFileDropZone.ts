import { DragEventHandler, RefObject, useEffect, useRef, useState } from 'react';
import { FilePond } from 'react-filepond';

type UseFileDropZoneParams = {
  containerRef: RefObject<HTMLDivElement | null>;
  filepondRef: RefObject<FilePond | null>;
};

type UseFileDropZoneReturn = {
  isDraggingOver: boolean;
  pastedFile: File | null;
  handleDragEnter: DragEventHandler<HTMLDivElement>;
  handleDragLeave: DragEventHandler<HTMLDivElement>;
  handleDragOver: DragEventHandler<HTMLDivElement>;
  handleDrop: DragEventHandler<HTMLDivElement>;
  handleConfirmUpload: (confirmed: boolean) => void;
};

export function useFileDropZone({ containerRef, filepondRef }: UseFileDropZoneParams): UseFileDropZoneReturn {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [pastedFile, setPastedFile] = useState<File | null>(null);
  const dragCounter = useRef(0);

  const handleDragEnter: DragEventHandler<HTMLDivElement> = event => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave: DragEventHandler<HTMLDivElement> = event => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDragOver: DragEventHandler<HTMLDivElement> = event => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDrop: DragEventHandler<HTMLDivElement> = event => {
    event.preventDefault();
    event.stopPropagation();

    dragCounter.current = 0;
    setIsDraggingOver(false);

    const droppedFiles = event.dataTransfer.files;

    if (filepondRef.current && droppedFiles.length > 0) {
      setTimeout(() => {
        Array.from(droppedFiles).forEach(file => {
          filepondRef.current?.addFile(file);
        });
      }, 0);
    }
  };

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const activeElement = document.activeElement as HTMLElement;

      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)
      ) {
        return;
      }

      const clipboardItems = event.clipboardData?.items;
      let hasFile = false;

      if (clipboardItems) {
        for (let i = 0; i < clipboardItems.length; i++) {
          const item = clipboardItems[i];
          if (item.kind === 'file') {
            hasFile = true;
            const file = item.getAsFile();
            if (file) {
              setPastedFile(file);
            }
          }
        }
      }

      if (hasFile) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const containerElement = containerRef.current;
    if (containerElement) {
      containerElement.addEventListener('paste', handlePaste);
    }

    return () => {
      if (containerElement) {
        containerElement.removeEventListener('paste', handlePaste);
      }
    };
  }, [containerRef]);

  const handleConfirmUpload = (confirmed: boolean) => {
    if (confirmed && pastedFile && filepondRef.current) {
      setTimeout(() => {
        filepondRef.current?.addFile(pastedFile);
      }, 0);
    }
    setPastedFile(null);
  };

  return {
    isDraggingOver,
    pastedFile,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleConfirmUpload,
  };
}
