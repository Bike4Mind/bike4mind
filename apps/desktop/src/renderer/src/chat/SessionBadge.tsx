import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import type { ChatSessionStatus } from '@shared/chat';
import { STATUS_LABEL } from './sessionStatus';

const sweep = keyframes({ from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } });

/** Matches the row's text block height, so numbered and unnumbered rows line up. */
const BADGE_SIZE = 18;

/**
 * The leading slot on a session row: what the session is doing, and its quick-switch number.
 *
 * ONE slot rather than two. The reference numbers the first nine rows and dots the rest, and
 * status has to share that space or every row grows a second marker that is blank on almost
 * all of them. So the number says which row this is, and the shape drawn around it says what
 * the row is doing - they are different channels and never compete for the same pixels.
 *
 * The three states differ in SILHOUETTE before they differ in colour - bare circle, ringed
 * circle, rounded square - because a status told only in colour is lost to a colour-blind user
 * and drifts between the two b4m themes. Colour is the redundant second cue and the label the
 * third: every badge names its state in words for a screen reader and on hover.
 *
 * 'needs-action' keeps the digit rather than replacing it with a glyph, so the row the user
 * most needs to reach is still the row they can reach by number.
 */
export function SessionBadge({ index, status }: { index: number | null; status: ChatSessionStatus }) {
  const label = STATUS_LABEL[status];
  const numbered = index !== null;
  const needsAction = status === 'needs-action';

  return (
    <Box
      aria-label={label}
      title={label}
      data-testid="session-status-badge"
      data-status={status}
      sx={{
        position: 'relative',
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {status === 'processing' && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '1.5px solid',
            borderColor: 'neutral.outlinedBorder',
            borderTopColor: 'primary.solidBg',
            animation: `${sweep} 900ms linear infinite`,
            // With motion off the ring still has to read as different from the idle circle, so
            // it closes into a solid one rather than simply standing still mid-sweep.
            '@media (prefers-reduced-motion: reduce)': { animation: 'none', borderColor: 'primary.solidBg' },
          }}
        />
      )}

      {needsAction && <Box sx={{ position: 'absolute', inset: 0, borderRadius: '5px', bgcolor: 'warning.solidBg' }} />}

      {numbered ? (
        <Typography
          level="body-xs"
          sx={{
            position: 'relative',
            fontSize: '10px',
            lineHeight: 1,
            fontWeight: 'lg',
            fontVariantNumeric: 'tabular-nums',
            color: needsAction ? 'warning.solidColor' : 'text.tertiary',
          }}
        >
          {index}
        </Typography>
      ) : needsAction ? (
        <Typography
          level="body-xs"
          sx={{ position: 'relative', fontSize: '10px', lineHeight: 1, fontWeight: 'lg', color: 'warning.solidColor' }}
        >
          !
        </Typography>
      ) : status === 'done' ? (
        <Box
          sx={{ width: 7, height: 7, borderRadius: '50%', border: '1px solid', borderColor: 'neutral.outlinedBorder' }}
        />
      ) : null}
    </Box>
  );
}
