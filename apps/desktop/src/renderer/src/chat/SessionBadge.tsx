import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import type { ChildOutcome } from '@shared/agentOutcome';
import { AGENT_STATE_LABEL, deriveAgentState } from '@shared/agentState';
import type { ChatSessionStatus } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import { PrStateIcon, prIconLabel } from './prStateStyle';
import { STATUS_LABEL, WORKING_COLOR } from './sessionStatus';

const sweep = keyframes({ from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } });

/** Wide enough for the ring and the square; the smaller marks sit centred inside it. */
const BADGE_SIZE = 14;

export type BadgeMarker = 'working' | 'needs-you' | 'failed' | 'pr' | 'stopped' | 'idle';

/**
 * Which mark a row shows. Live status first, then a failed last turn (worth seeing over a standing
 * PR), then the PR, then a turn cut short by a step or context limit. A finished session looks idle
 * on purpose: nearly every chat ends 'finished', so a done mark would only be noise. A user-pressed
 * Stop looks idle too: the user already knows, and only a run that stopped itself is worth flagging.
 */
export function badgeMarker(status: ChatSessionStatus, outcome: ChildOutcome | undefined, hasPr: boolean): BadgeMarker {
  const state = deriveAgentState(status, outcome);
  if (state === 'working' || state === 'needs-you' || state === 'failed') return state;
  if (hasPr) return 'pr';
  return (state === 'stopped' || state === 'paused') && outcome !== 'aborted' ? 'stopped' : 'idle';
}

/**
 * The leading marker on a session row: what that session is doing.
 *
 * One component at every nesting depth, and states differ in SILHOUETTE before colour - open arc,
 * rounded square with "!", cross, small square, dot - so a colour-blind user and both themes read
 * them the same. Colour is the second cue and the label the third: every badge names its state for
 * a screen reader and on hover.
 *
 * The spinner draws no grey track: a track in the border colour vanished on a selected row and
 * dimmed the arc everywhere else, which made one spinner look like two.
 */
export function SessionBadge({
  status,
  pr,
  outcome,
  deciding = false,
}: {
  status: ChatSessionStatus;
  pr?: PrSummary | undefined;
  /** How the session's last turn ended, from its summary; decides failed and stopped. */
  outcome?: ChildOutcome | undefined;
  /** A worker waiting on a decision only the user can make, which names itself more precisely. */
  deciding?: boolean;
}) {
  const marker = badgeMarker(status, outcome, pr !== undefined);
  const label =
    marker === 'pr' && pr
      ? prIconLabel(pr.number, pr)
      : marker === 'needs-you' && deciding
        ? 'Needs your decision'
        : marker === 'failed' || marker === 'stopped'
          ? AGENT_STATE_LABEL[marker]
          : STATUS_LABEL[status];

  return (
    <Box
      aria-label={label}
      title={label}
      data-testid="session-status-badge"
      data-status={status}
      data-state={marker}
      data-pr-state={marker === 'pr' && pr ? pr.state : undefined}
      data-pr-attention={marker === 'pr' && pr && pr.state === 'open' ? pr.attention : undefined}
      sx={{
        position: 'relative',
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {marker === 'working' && (
        <>
          <Box
            data-testid="session-status-spinner"
            sx={{
              position: 'absolute',
              inset: '1px',
              borderRadius: '50%',
              border: '2px solid',
              borderColor: WORKING_COLOR,
              borderRightColor: 'transparent',
              animation: `${sweep} 900ms linear infinite`,
              // With motion off the arc closes into a ring around a dot, so it still reads apart
              // from the idle dot instead of freezing mid-sweep.
              '@media (prefers-reduced-motion: reduce)': { animation: 'none', borderRightColor: WORKING_COLOR },
            }}
          />
          <Box
            sx={{
              display: 'none',
              width: 4,
              height: 4,
              borderRadius: '50%',
              bgcolor: WORKING_COLOR,
              '@media (prefers-reduced-motion: reduce)': { display: 'block' },
            }}
          />
        </>
      )}

      {marker === 'needs-you' && (
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

      {marker === 'failed' && (
        <Box component="svg" viewBox="0 0 10 10" aria-hidden sx={{ width: 10, height: 10, color: 'danger.plainColor' }}>
          <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
        </Box>
      )}

      {marker === 'pr' && pr && <PrStateIcon status={pr} size={BADGE_SIZE} />}

      {marker === 'stopped' && <Box sx={{ width: 7, height: 7, borderRadius: '2px', bgcolor: 'text.secondary' }} />}

      {marker === 'idle' && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'text.tertiary' }} />}
    </Box>
  );
}
