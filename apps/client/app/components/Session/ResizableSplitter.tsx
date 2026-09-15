import React, { useCallback, useState, useTransition } from 'react';
import { Box } from '@mui/joy';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';

interface ResizableSplitterProps {
  onWidthChange?: (newWidth: number) => void;
}

// Use a single shared state outside React to avoid re-renders during drag
const dragState = {
  isDragging: false,
  startX: 0,
  startWidth: 50,
  currentWidth: 50,
};

const ResizableSplitter: React.FC<ResizableSplitterProps> = ({ onWidthChange }) => {
  const knowledgeViewerWidth = useSessionLayout(s => s.knowledgeViewerWidth) || 50;
  const [isDragging, setIsDragging] = useState(false);
  const [, startTransition] = useTransition();

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();

      const container = e.currentTarget as HTMLElement;
      const parent = container.parentElement;
      if (!parent) return;

      // Set up drag state
      dragState.isDragging = true;
      dragState.startX = e.clientX;
      dragState.startWidth = knowledgeViewerWidth;
      dragState.currentWidth = knowledgeViewerWidth;

      setIsDragging(true);

      // Capture pointer
      container.setPointerCapture(e.pointerId);

      // Prevent text selection during drag
      const body = document.body;
      body.style.userSelect = 'none';
      body.style.cursor = 'col-resize';

      // Get the containers we'll be updating
      const knowledgeViewer = parent.children[0] as HTMLElement;
      const chat = parent.children[2] as HTMLElement; // Splitter is at index 1

      const handlePointerMove = (e: PointerEvent) => {
        if (!dragState.isDragging) return;

        const parentRect = parent.getBoundingClientRect();
        const deltaX = e.clientX - dragState.startX;
        const deltaPercent = (deltaX / parentRect.width) * 100;
        // Minus, not plus: SessionContainer renders the split row-reversed, so the viewer
        // sits to the RIGHT of this handle and dragging right has to shrink it.
        const newWidth = Math.max(20, Math.min(80, dragState.startWidth - deltaPercent));

        dragState.currentWidth = newWidth;

        // Update DOM directly for instant feedback
        knowledgeViewer.style.width = `${newWidth}%`;
        chat.style.width = `${100 - newWidth}%`;
      };

      const handlePointerUp = (e: PointerEvent) => {
        if (!dragState.isDragging) return;

        dragState.isDragging = false;
        setIsDragging(false);

        // Reset body styles
        body.style.userSelect = '';
        body.style.cursor = '';

        // Clear inline styles
        knowledgeViewer.style.width = '';
        chat.style.width = '';

        // Clean up event listeners
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);

        // Commit the final width to React state in a transition
        const finalWidth = dragState.currentWidth;
        startTransition(() => {
          setSessionLayout({ knowledgeViewerWidth: finalWidth });
          onWidthChange?.(finalWidth);
        });
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [knowledgeViewerWidth, onWidthChange, startTransition]
  );

  return (
    <Box
      sx={{
        // Negative margin so the handle overlaps BOTH panes evenly and reads as the boundary
        // between them rather than as chrome belonging to either pane.
        width: '8px',
        marginX: '-6px',
        cursor: 'col-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        zIndex: 10,
        touchAction: 'none', // Prevent touch scrolling during drag
        // The visible mark is a short centered bar, not a full-height rule. It lives on
        // ::before so the element itself stays a full-height 8px grab strip -- a 2px-wide
        // hit area would be near-impossible to catch with a pointer.
        '&::before': {
          content: '""',
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '2px',
          height: '32px',
          backgroundColor: 'divider',
          transition: 'background-color 0.2s ease',
        },
        '&:hover::before, &[data-dragging="true"]::before': {
          // primary.500, not primary.main: Joy's palette has no `main` key (that is Material
          // UI), so the string falls through as an invalid CSS value and nothing happens.
          backgroundColor: 'primary.500',
        },
      }}
      onPointerDown={handlePointerDown}
      data-dragging={isDragging}
      aria-label="Drag to resize"
    />
  );
};

export default ResizableSplitter;
