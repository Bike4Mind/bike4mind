import { FC, ReactNode, createContext, useContext, useRef } from 'react';
import { Box } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import { useOverflowCompact } from '@client/app/components/Session/AISettings/useOverflowCompact';

interface ComposerStatusLineProps {
  left?: ReactNode;
  right?: ReactNode;
  sx?: SxProps;
}

const ITEM_GAP = '8px';

const StatusLineCompactContext = createContext(false);

/**
 * True when the status line has run out of room: its items drop their words and keep an icon and a
 * number (NotebookFilesChip, ResearchModeIndicator, CreditBalanceChipView), the full wording moving
 * to their tooltip and accessible name.
 */
export const useStatusLineCompact = () => useContext(StatusLineCompactContext);

/**
 * Quiet line above the composer box for notebook and account state (the notebook's files and
 * Research Mode on the left, context and the balance on the right). What travels with the message
 * stays inside the box. The caller sizes it to match the box, since the two are siblings.
 */
const ComposerStatusLine: FC<ComposerStatusLineProps> = ({ left, right, sx }) => {
  // The left side is the one that gives way (minWidth 0), so its overflow is the signal. It takes all
  // the free space (flex 1) rather than hugging its items: once they shrink to icons, a hugging box
  // would shrink with them and never measure wide enough to expand again.
  const leftRef = useRef<HTMLDivElement>(null);
  const compact = useOverflowCompact(leftRef);

  return (
    <StatusLineCompactContext.Provider value={compact}>
      <Box
        data-testid="composer-status-line"
        data-compact={compact || undefined}
        sx={[
          {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            px: '8px',
            // 36px tall with the 24px items. SessionMiddle's scroll-to-bottom button hangs into this
            // line by its height minus 16px - keep in sync.
            pt: '8px',
            pb: '4px',
          },
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        {/* One gap between items on both sides; each item adds its own ~6px padding on top. */}
        <Box
          ref={leftRef}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: ITEM_GAP,
            flex: 1,
            minWidth: 0,
            // Items keep their width instead of squeezing their text into each other, so running out
            // of room shows up as overflow - the signal that collapses them.
            '& > *': { flexShrink: 0 },
          }}
        >
          {left}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: ITEM_GAP, flexShrink: 0 }}>{right}</Box>
      </Box>
    </StatusLineCompactContext.Provider>
  );
};

export default ComposerStatusLine;
