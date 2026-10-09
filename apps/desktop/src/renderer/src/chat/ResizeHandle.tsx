import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Box from '@mui/joy/Box';

/** Arrow-key step. A sixth of the sidebar's range, so the whole of it is a handful of presses away. */
const RESIZE_STEP = 16;

/**
 * The strip on a column's edge that sets its width: the sidebar's right edge, the browser
 * pane's left one. `edge` is which side of the column it sits on, and so which way a drag grows it.
 *
 * The drag runs on window listeners, with the handle's own pointer capture only on top. Capture
 * cannot be relied on alone: the pointer leaves this 5px strip on the first frame of any drag
 * worth making, and where the capture does not hold - which is anywhere the input is synthesised
 * rather than a real device, so every driven test of this - the width stops following the
 * pointer after one step and silently commits short. Where it does hold it keeps the stream
 * coming while the pointer is over something that is not this document's, like the native page
 * view of the browser pane.
 *
 * `onWidth` follows the pointer; `onCommit` is the release, a key press or a reset, and is
 * where a consumer persists. The width is held in a ref as well as pushed up, because a
 * pointermove is not a discrete event: React is free to defer the state it sets, and the value
 * read on pointerup would then be a frame or two behind the pointer.
 *
 * Wider than the line it draws: 5px is the thinnest strip a pointer finds without aiming. The
 * consumer places it with `sx`.
 */
export function ResizeHandle({
  edge,
  label,
  testId,
  width,
  min,
  max,
  defaultWidth,
  clamp,
  dragging,
  onWidth,
  onCommit,
  onDraggingChange,
  sx,
}: {
  edge: 'left' | 'right';
  label: string;
  testId: string;
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  clamp: (width: number) => number;
  dragging: boolean;
  onWidth: (width: number) => void;
  onCommit: (width: number) => void;
  onDraggingChange: (dragging: boolean) => void;
  sx: { left: number } | { right: number };
}) {
  const drag = useRef<{ x: number; from: number; to: number } | null>(null);
  const grow = edge === 'right' ? 1 : -1;

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      current.to = clamp(current.from + grow * (event.clientX - current.x));
      onWidth(current.to);
    };
    const onEnd = () => {
      const current = drag.current;
      drag.current = null;
      onDraggingChange(false);
      if (current) onCommit(current.to);
    };

    // The pointer spends the drag over the transcript, which selects text and draws an I-beam.
    // Both are set on the document because that is how far the drag reaches.
    const { userSelect, cursor } = document.body.style;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      document.body.style.userSelect = userSelect;
      document.body.style.cursor = cursor;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [dragging, grow, clamp, onWidth, onCommit, onDraggingChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Without this the press that starts the drag also starts a selection in the text it
    // began next to, before the rule above has had a render to take effect.
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No such pointer (synthesised input): the window listeners carry the drag on their own.
    }
    drag.current = { x: event.clientX, from: width, to: width };
    onDraggingChange(true);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const arrow = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (arrow === 0) return;
    event.preventDefault();
    const next = clamp(width + arrow * grow * RESIZE_STEP);
    onWidth(next);
    onCommit(next);
  };

  const reset = () => {
    const next = clamp(defaultWidth);
    onWidth(next);
    onCommit(next);
  };

  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
      sx={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        ...sx,
        width: 5,
        zIndex: 2,
        cursor: 'col-resize',
        // The pointer stream is the whole mechanism; without this a trackpad drag scrolls the
        // content under it instead.
        touchAction: 'none',
        bgcolor: 'transparent',
        transition: 'background-color 120ms',
        '&:hover, &:focus-visible, &[data-dragging="true"]': { bgcolor: 'primary.outlinedBorder' },
        '&:focus-visible': { outline: 'none' },
      }}
      data-dragging={dragging ? 'true' : undefined}
      data-testid={testId}
    />
  );
}
