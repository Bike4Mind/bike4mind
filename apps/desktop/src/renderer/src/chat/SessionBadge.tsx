import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import type { ChatSessionStatus } from '@shared/chat';
import { STATUS_LABEL } from './sessionStatus';

const sweep = keyframes({ from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } });

/** Wide enough for the ring and the square; the idle dot sits centred inside it. */
const BADGE_SIZE = 14;

/**
 * The leading marker on a session row: what that session is doing.
 *
 * The three states differ in SILHOUETTE before they differ in colour - hollow dot, ringed
 * circle, rounded square - because a status told only in colour is lost to a colour-blind user
 * and drifts between the two b4m themes. Colour is the redundant second cue and the label the
 * third: every badge names its state in words for a screen reader and on hover.
 *
 * Idle keeps the reference's small hollow dot, so a quiet sidebar stays quiet and only a row
 * that is actually doing something draws the eye.
 */
export function SessionBadge({ status }: { status: ChatSessionStatus }) {
  const label = STATUS_LABEL[status];

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
            // With motion off the ring still has to read as different from the idle dot, so it
            // closes into a solid one rather than simply standing still mid-sweep.
            '@media (prefers-reduced-motion: reduce)': { animation: 'none', borderColor: 'primary.solidBg' },
          }}
        />
      )}

      {status === 'needs-action' && (
        <>
          <Box sx={{ position: 'absolute', inset: 0, borderRadius: '4px', bgcolor: 'warning.solidBg' }} />
          <Typography
            level="body-xs"
            sx={{
              position: 'relative',
              fontSize: '9px',
              lineHeight: 1,
              fontWeight: 'lg',
              color: 'warning.solidColor',
            }}
          >
            !
          </Typography>
        </>
      )}

      {status === 'done' && (
        <Box
          sx={{ width: 6, height: 6, borderRadius: '50%', border: '1px solid', borderColor: 'neutral.outlinedBorder' }}
        />
      )}
    </Box>
  );
}
