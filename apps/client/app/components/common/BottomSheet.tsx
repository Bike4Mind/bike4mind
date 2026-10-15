import { FC, PointerEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Drawer, IconButton, Typography } from '@mui/joy';
import ArrowBack from '@mui/icons-material/ArrowBack';
import { HEADER_ICON_BUTTON_SX } from '@client/app/components/Session/AISettings/headerIconButtonSx';

// A drag past this distance closes the sheet, as does a quick flick past FLICK_MIN_PX.
const CLOSE_DISTANCE_PX = 80;
const FLICK_MIN_PX = 24;
const FLICK_SPEED_PX_PER_MS = 0.5;

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the sheet's dialog. */
  label: string;
  /** Hold the height the sheet has now, e.g. while a sub-view replaces its list: a shorter view
   *  leaves room below, a taller one scrolls, and the sheet does not jump under the finger. */
  keepHeight?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * Phone sheet that rises from the bottom edge, full width. Closes on a tap outside, Escape, or a
 * swipe down on the handle at its top. Content taller than the sheet scrolls inside it.
 */
const BottomSheet: FC<BottomSheetProps> = ({
  open,
  onClose,
  label,
  keepHeight = false,
  children,
  'data-testid': testId,
}) => {
  const [dragY, setDragY] = useState<number | null>(null);
  // The Drawer keeps its children while closed, so it is not mounted until the first open. The
  // double frame lets the first open still animate in from closed.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    setMounted(true);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(id);
  }, [open]);
  const drag = useRef<{ startY: number; startTime: number; y: number } | null>(null);

  // Holds the body at the height it had before keepHeight turned on. By the render that turns it on
  // the children have already changed, so the height comes from the previous render's measurement.
  // Set on the element directly, before paint: it is a measurement of what rendered, not state. The
  // Drawer's portal mounts the body after this component's first render, so its mount re-renders
  // this component (bodyMounted) to measure it too.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyMounted, setBodyMounted] = useState(false);
  const attachBody = useCallback((el: HTMLDivElement | null) => {
    bodyRef.current = el;
    setBodyMounted(!!el);
  }, []);
  const freeHeight = useRef(0);

  // Touch scrollbars are faint or hidden, so a fade at an edge says there is more past it. Marked on
  // the wrapper as attributes (CSS shows the fades) for the same reason the height is set directly.
  const wrapRef = useRef<HTMLDivElement>(null);
  const markEdges = useCallback(() => {
    const el = bodyRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    wrap.toggleAttribute('data-more-above', el.scrollTop > 1);
    wrap.toggleAttribute('data-more-below', el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (keepHeight) {
      if (!el.style.height && freeHeight.current > 0) el.style.height = `${freeHeight.current}px`;
    } else {
      el.style.height = '';
      freeHeight.current = el.offsetHeight;
    }
    // Content changes come with a render; size changes (rotation, the keyboard) do not.
    markEdges();
  });
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(markEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bodyMounted, markEdges]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: e.clientY, startTime: performance.now(), y: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragY(0);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // Only downwards: the sheet already shows everything it can above.
    drag.current.y = Math.max(0, e.clientY - drag.current.startY);
    setDragY(drag.current.y);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragY(null);
    if (!d) return;
    const speed = d.y / Math.max(1, performance.now() - d.startTime);
    if (d.y > CLOSE_DISTANCE_PX || (d.y > FLICK_MIN_PX && speed > FLICK_SPEED_PX_PER_MS)) onClose();
  };

  if (!mounted) return null;

  return (
    <Drawer
      anchor="bottom"
      open={shown}
      onClose={onClose}
      slotProps={{
        content: {
          'aria-label': label,
          ...(testId && { 'data-testid': testId }),
          sx: {
            height: 'auto',
            maxHeight: '85dvh',
            display: 'flex',
            flexDirection: 'column',
            borderTopLeftRadius: '16px',
            borderTopRightRadius: '16px',
            backgroundColor: 'background.surface',
            pb: 'calc(8px + env(safe-area-inset-bottom))',
            // Follows the finger while dragging; on release Joy's own transform takes over again and
            // animates the sheet back up, or away if the drag closed it.
            ...(dragY !== null && { transform: `translateY(${dragY}px)`, transition: 'none' }),
          },
        },
      }}
    >
      <Box
        data-testid="bottom-sheet-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        sx={{
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'center',
          py: '10px',
          cursor: 'grab',
          // The page must not scroll or zoom while the handle is being dragged.
          touchAction: 'none',
        }}
      >
        <Box
          aria-hidden
          sx={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: 'neutral.outlinedBorder' }}
        />
      </Box>
      <Box
        ref={wrapRef}
        data-testid="bottom-sheet-scroll-area"
        sx={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 1,
          minHeight: 0,
          '&::before, &::after': {
            content: '""',
            position: 'absolute',
            left: 0,
            right: 0,
            height: '40px',
            zIndex: 1,
            pointerEvents: 'none',
            opacity: 0,
            transition: 'opacity 0.2s',
          },
          '&::before': {
            top: 0,
            background: 'linear-gradient(to bottom, var(--joy-palette-background-surface), transparent)',
          },
          '&::after': {
            bottom: 0,
            background: 'linear-gradient(to top, var(--joy-palette-background-surface), transparent)',
          },
          '&[data-more-above]::before, &[data-more-below]::after': { opacity: 1 },
        }}
      >
        <Box
          ref={attachBody}
          data-testid="bottom-sheet-body"
          onScroll={markEdges}
          sx={{
            overflowY: 'auto',
            px: '8px',
            // A held height still gives way to the sheet's own max height.
            flexShrink: 1,
            minHeight: 0,
          }}
        >
          {children}
        </Box>
      </Box>
    </Drawer>
  );
};

/**
 * Header of a sub-view that replaces a sheet's list: a back arrow to the list and the view's name.
 * `titleId` lets the view's content take the name as its label.
 */
export const BottomSheetHeader: FC<{ title: string; onBack: () => void; titleId?: string; backTestId?: string }> = ({
  title,
  onBack,
  titleId,
  backTestId,
}) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', minHeight: '44px' }}>
    <IconButton
      data-testid={backTestId}
      aria-label="Back"
      variant="plain"
      color="neutral"
      onClick={onBack}
      // Like the Tools and Agents dropdown headers' buttons, a touch larger for a finger.
      sx={{ ...HEADER_ICON_BUTTON_SX, '--IconButton-size': '32px' }}
    >
      <ArrowBack sx={{ fontSize: '18px' }} />
    </IconButton>
    <Typography id={titleId} level="title-sm" sx={{ color: 'text.primary' }}>
      {title}
    </Typography>
  </Box>
);

export default BottomSheet;
