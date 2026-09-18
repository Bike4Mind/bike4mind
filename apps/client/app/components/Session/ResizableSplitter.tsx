import React, { useCallback, useState, useTransition } from 'react';
import { Box } from '@mui/joy';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';

interface ResizableSplitterProps {
  onWidthChange?: (newWidth: number) => void;
}

// The knowledge pane never takes less than MIN or more than MAX of the split. Shared by the
// pointer and keyboard paths so the two clamps cannot drift apart.
const MIN_WIDTH_PERCENT = 20;
const MAX_WIDTH_PERCENT = 80;
// One arrow press. Deliberately fine rather than fast: Home/End already cover the extremes,
// so the arrows are the precision control.
const KEY_STEP_PERCENT = 2;

const clampWidth = (width: number) => Math.max(MIN_WIDTH_PERCENT, Math.min(MAX_WIDTH_PERCENT, width));

// Use a single shared state outside React to avoid re-renders during drag
const dragState = {
  isDragging: false,
  startX: 0,
  startWidth: 50,
  currentWidth: 50,
};

const SPLITTER_WIDTH_PX = 8;

const ResizableSplitter: React.FC<ResizableSplitterProps> = ({ onWidthChange }) => {
  const knowledgeViewerWidth = useSessionLayout(s => s.knowledgeViewerWidth) || 50;
  const [isDragging, setIsDragging] = useState(false);
  const [, startTransition] = useTransition();

  // A drag commits a fractional width, so round before announcing it or stepping off it:
  // otherwise aria-valuenow and the stored width drift apart for the rest of the session.
  const roundedWidth = Math.round(knowledgeViewerWidth);
  // The announced value tracks the CHAT pane even though the stored width is the knowledge
  // pane's, so the number rises as the separator moves right the way a slider's does. Derived
  // by subtracting the ROUNDED width rather than rounding 100 - width, so the two panes always
  // sum to exactly 100. The 20-80 clamp is symmetric, so valuemin/valuemax hold either way.
  const chatPaneWidth = 100 - roundedWidth;

  const commitWidth = useCallback(
    (newWidth: number) => {
      setSessionLayout({ knowledgeViewerWidth: newWidth });
      onWidthChange?.(newWidth);
    },
    [onWidthChange]
  );

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
        const newWidth = clampWidth(dragState.startWidth - deltaPercent);

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
          commitWidth(finalWidth);
        });
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [commitWidth, knowledgeViewerWidth, startTransition]
  );

  // Arrow keys step the separator, Home/End jump to the clamps. All four are named for where
  // the separator MOVES, so they carry the same sign flip as the drag: the viewer is the
  // right-hand pane, so moving the separator right shrinks it. Home is therefore the viewer's
  // MAX (separator hard left) and End its MIN, which is also what puts Home on aria-valuemin
  // and End on aria-valuemax, since the announced value is the chat pane's.
  const handleKeyResize = useCallback(
    (e: React.KeyboardEvent) => {
      let newWidth: number;

      switch (e.key) {
        case 'ArrowLeft':
          newWidth = clampWidth(roundedWidth + KEY_STEP_PERCENT);
          break;
        case 'ArrowRight':
          newWidth = clampWidth(roundedWidth - KEY_STEP_PERCENT);
          break;
        case 'Home':
          newWidth = MAX_WIDTH_PERCENT;
          break;
        case 'End':
          newWidth = MIN_WIDTH_PERCENT;
          break;
        default:
          return;
      }

      // These keys would otherwise scroll whichever pane is behind the handle.
      e.preventDefault();

      if (newWidth !== knowledgeViewerWidth) commitWidth(newWidth);
    },
    [commitWidth, knowledgeViewerWidth, roundedWidth]
  );

  return (
    <Box
      sx={{
        // Negative margins so the handle straddles the pane boundary and reads as the
        // boundary itself rather than as chrome belonging to either pane. They have to be
        // exactly half the width, because SessionContainer sizes the two panes in
        // percentages that already sum to 100% and no child of that row sets flex-grow:
        // anything the handle subtracts survives as free space instead of being absorbed.
        // A positive contribution would not: the default flex-shrink: 1 absorbs overflow,
        // which is how this broke before. The row is row-reverse with the default
        // justify-content, so the leftover parks on the physical left of the chat pane.
        width: `${SPLITTER_WIDTH_PX}px`,
        marginX: `${-(SPLITTER_WIDTH_PX / 2)}px`,
        cursor: 'col-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        zIndex: 10,
        touchAction: 'none', // Prevent touch scrolling during drag
        // The visible mark is a short centered bar, not a full-height rule. It lives on
        // ::before so the element itself stays a full-height grab strip -- a 2px-wide
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
        '&:hover::before, &:focus-visible::before, &[data-dragging="true"]::before': {
          // primary.500, not primary.main: Joy's palette has no `main` key (that is Material
          // UI), so the string falls through as an invalid CSS value and nothing happens.
          backgroundColor: 'primary.500',
        },
        // The handle is keyboard-focusable, so it needs its own focus indicator. The ring
        // goes on the bar, not the element: the negative margins mean an outline on the
        // full-height grab strip would be drawn across both panes' content.
        '&:focus-visible': {
          outline: 'none',
        },
        '&:focus-visible::before': {
          outline: '2px solid',
          outlineColor: 'primary.500',
          outlineOffset: '3px',
        },
      }}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyResize}
      data-dragging={isDragging}
      data-testid="session-splitter-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the chat and knowledge panes"
      aria-valuenow={chatPaneWidth}
      aria-valuemin={MIN_WIDTH_PERCENT}
      aria-valuemax={MAX_WIDTH_PERCENT}
      // Without this a screen reader reads the value as its position in the 20-80 range
      // (a 32% split announced as "20%"), which is worse than saying nothing.
      aria-valuetext={`Chat pane ${chatPaneWidth}%`}
      tabIndex={0}
    />
  );
};

export default ResizableSplitter;
