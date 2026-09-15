import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileDropZone } from '../useFileDropZone';

function createDragEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files: [] },
    ...overrides,
  } as unknown as React.DragEvent<HTMLDivElement>;
}

function createMockFilepondRef() {
  return { current: { addFile: vi.fn() } } as unknown as React.RefObject<{
    addFile: (file: File) => void;
  } | null>;
}

describe('useFileDropZone', () => {
  let containerRef: React.RefObject<HTMLDivElement | null>;
  let filepondRef: ReturnType<typeof createMockFilepondRef>;

  beforeEach(() => {
    containerRef = { current: document.createElement('div') };
    filepondRef = createMockFilepondRef();
    vi.clearAllMocks();
  });

  it('should start with isDraggingOver as false', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    expect(result.current.isDraggingOver).toBe(false);
  });

  it('should set isDraggingOver to true on first dragEnter', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    act(() => {
      result.current.handleDragEnter(createDragEvent());
    });

    expect(result.current.isDraggingOver).toBe(true);
  });

  it('should track nested dragEnter/dragLeave correctly', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    // Enter parent
    act(() => {
      result.current.handleDragEnter(createDragEvent());
    });
    expect(result.current.isDraggingOver).toBe(true);

    // Enter child (nested)
    act(() => {
      result.current.handleDragEnter(createDragEvent());
    });
    expect(result.current.isDraggingOver).toBe(true);

    // Leave child
    act(() => {
      result.current.handleDragLeave(createDragEvent());
    });
    expect(result.current.isDraggingOver).toBe(true);

    // Leave parent
    act(() => {
      result.current.handleDragLeave(createDragEvent());
    });
    expect(result.current.isDraggingOver).toBe(false);
  });

  it('should reset isDraggingOver on drop', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    act(() => {
      result.current.handleDragEnter(createDragEvent());
    });
    expect(result.current.isDraggingOver).toBe(true);

    act(() => {
      result.current.handleDrop(createDragEvent());
    });
    expect(result.current.isDraggingOver).toBe(false);
  });

  it('should add dropped files to FilePond', () => {
    vi.useFakeTimers();
    const mockFile = new File(['test'], 'test.txt', { type: 'text/plain' });

    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    act(() => {
      result.current.handleDrop(createDragEvent({ dataTransfer: { files: [mockFile] } }));
    });

    act(() => {
      vi.runAllTimers();
    });

    expect(filepondRef.current?.addFile).toHaveBeenCalledWith(mockFile);
    vi.useRealTimers();
  });

  it('should prevent default on dragOver', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    const event = createDragEvent();
    act(() => {
      result.current.handleDragOver(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('should start with pastedFile as null', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    expect(result.current.pastedFile).toBeNull();
  });

  it('should add file to FilePond on confirm upload', () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    const mockFile = new File(['img'], 'screenshot.png', { type: 'image/png' });

    // Simulate a paste event on the container to set pastedFile
    act(() => {
      const pasteEvent = new Event('paste', { bubbles: true }) as unknown as ClipboardEvent;
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [{ kind: 'file', getAsFile: () => mockFile }],
        },
      });
      containerRef.current?.dispatchEvent(pasteEvent);
    });

    expect(result.current.pastedFile).toBe(mockFile);

    act(() => {
      result.current.handleConfirmUpload(true);
    });

    act(() => {
      vi.runAllTimers();
    });

    expect(filepondRef.current?.addFile).toHaveBeenCalledWith(mockFile);
    expect(result.current.pastedFile).toBeNull();
    vi.useRealTimers();
  });

  it('should clear pastedFile on cancel upload', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    const mockFile = new File(['img'], 'screenshot.png', { type: 'image/png' });

    // Simulate paste
    act(() => {
      const pasteEvent = new Event('paste', { bubbles: true }) as unknown as ClipboardEvent;
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [{ kind: 'file', getAsFile: () => mockFile }],
        },
      });
      containerRef.current?.dispatchEvent(pasteEvent);
    });

    expect(result.current.pastedFile).toBe(mockFile);

    act(() => {
      result.current.handleConfirmUpload(false);
    });

    expect(result.current.pastedFile).toBeNull();
    expect(filepondRef.current?.addFile).not.toHaveBeenCalled();
  });

  it('should not intercept paste on input elements', () => {
    const { result } = renderHook(() => useFileDropZone({ containerRef, filepondRef: filepondRef as never }));

    // Focus an input element
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const mockFile = new File(['img'], 'screenshot.png', { type: 'image/png' });

    act(() => {
      const pasteEvent = new Event('paste', { bubbles: true }) as unknown as ClipboardEvent;
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [{ kind: 'file', getAsFile: () => mockFile }],
        },
      });
      containerRef.current?.dispatchEvent(pasteEvent);
    });

    expect(result.current.pastedFile).toBeNull();

    document.body.removeChild(input);
  });
});
