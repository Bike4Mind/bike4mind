import { FC, PointerEvent, ReactNode, useRef, useState } from 'react';
import { Box, Drawer } from '@mui/joy';

// A drag past this distance closes the sheet, as does a quick flick past FLICK_MIN_PX.
const CLOSE_DISTANCE_PX = 80;
const FLICK_MIN_PX = 24;
const FLICK_SPEED_PX_PER_MS = 0.5;

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the sheet's dialog. */
  label: string;
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * Phone sheet that rises from the bottom edge, full width. Closes on a tap outside, Escape, or a
 * swipe down on the handle at its top. Content taller than the sheet scrolls inside it.
 */
const BottomSheet: FC<BottomSheetProps> = ({ open, onClose, label, children, 'data-testid': testId }) => {
  const [dragY, setDragY] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startTime: number; y: number } | null>(null);

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

  return (
    <Drawer
      anchor="bottom"
      open={open}
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
      <Box sx={{ overflowY: 'auto', px: '8px' }}>{children}</Box>
    </Drawer>
  );
};

export default BottomSheet;
