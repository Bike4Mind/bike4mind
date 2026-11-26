import Box from '@mui/joy/Box';
import { useTheme } from '@mui/joy/styles';
import { keyframes } from '@mui/system';
import type { PrAttention, PrIconStatus } from '@shared/prAttention';
import type { PrDisplayState } from '@shared/pullRequest';
import { MergedIcon, PrCornerGlyph, PullRequestClosedIcon, PullRequestIcon, type PrCornerGlyphKind } from './icons';

/**
 * How a PR's state is drawn, for both PrStatusBar and the sidebar's session rows. Neither picks
 * a colour or an icon of its own: a row's icon and its conversation's bar must always agree.
 */

/**
 * GitHub's merged purple for each mode. Joy's palette has no purple, and its nearest token
 * (primary blue) would read as "open", the opposite of what a merged bar should say.
 */
export const MERGED_COLOR = { light: '#8250df', dark: '#a371f7' } as const;

/** GitHub's orange, for changes requested: Joy has none, and warning yellow already means CI running. */
export const CHANGES_REQUESTED_COLOR = { light: '#bc4c00', dark: '#f0883e' } as const;

/** GitHub's bright green, so ready reads apart from approved-but-blocked (Joy's success green). */
export const READY_COLOR = { light: '#1a7f37', dark: '#3fb950' } as const;

export type ThemeMode = 'light' | 'dark';

export const PR_STATE_LABEL: Record<PrDisplayState, string> = {
  open: 'Open',
  draft: 'Draft',
  queued: 'Queued to merge',
  merged: 'Merged',
  closed: 'Closed',
};

export const PR_ATTENTION_LABEL: Record<PrAttention, string> = {
  conflict: 'merge conflicts',
  ciFailed: 'CI failed',
  changesRequested: 'changes requested',
  ciRunning: 'CI running',
  awaitingReview: 'awaiting review',
  approvedBlocked: 'merge blocked',
  ready: 'ready to merge',
};

/** Joy palette tokens where the theme has the colour; see MERGED_COLOR for the one it lacks. */
export function prStateColor(state: PrDisplayState, mode: ThemeMode): string {
  switch (state) {
    case 'open':
      return 'success.plainColor';
    case 'draft':
      return 'text.tertiary';
    case 'queued':
      return 'warning.plainColor';
    case 'merged':
      return MERGED_COLOR[mode];
    case 'closed':
      return 'danger.plainColor';
  }
}

function attentionColor(attention: PrAttention | undefined, mode: ThemeMode): string {
  switch (attention) {
    case 'conflict':
    case 'ciFailed':
      return 'danger.plainColor';
    case 'changesRequested':
      return CHANGES_REQUESTED_COLOR[mode];
    case 'ciRunning':
      return 'warning.plainColor';
    case 'approvedBlocked':
      return 'success.plainColor';
    case 'ready':
      return READY_COLOR[mode];
    case 'awaitingReview':
    case undefined:
      // Nothing to act on, or nothing known yet: neutral, so only rows that need something draw the eye.
      return 'text.secondary';
  }
}

/** An open PR is coloured by what it waits on; every other state keeps its own colour. */
export function prIconColor(status: PrIconStatus, mode: ThemeMode): string {
  return status.state === 'open' ? attentionColor(status.attention, mode) : prStateColor(status.state, mode);
}

/** A closed PR is muted: it is over, but unlike a merged one it did not land. */
export function prStateOpacity(state: PrDisplayState): number {
  return state === 'closed' ? 0.7 : 1;
}

/** Last-known values fade further, so a row not re-read this launch does not claim to be current. */
function iconOpacity(status: PrIconStatus): number {
  return status.stale ? Math.min(prStateOpacity(status.state), 0.55) : prStateOpacity(status.state);
}

/** "PR #42 - Open: changes requested, behind base". Every icon names itself in words, never colour alone. */
export function prIconLabel(number: number, status: PrIconStatus): string {
  const details = [
    status.state === 'open' && status.attention ? PR_ATTENTION_LABEL[status.attention] : null,
    status.state === 'open' && status.behind ? 'behind base' : null,
    status.state === 'open' && status.autoMerge ? 'auto-merge on' : null,
    status.stale ? 'last known' : null,
  ].filter((detail): detail is string => detail !== null);
  const base = `PR #${number} - ${PR_STATE_LABEL[status.state]}`;
  return details.length > 0 ? `${base}: ${details.join(', ')}` : base;
}

const ICONS: Record<PrDisplayState, typeof PullRequestIcon> = {
  open: PullRequestIcon,
  draft: PullRequestIcon,
  queued: PullRequestIcon,
  merged: MergedIcon,
  closed: PullRequestClosedIcon,
};

/** awaitingReview has none: it is the quiet, nothing-to-do state. */
const ATTENTION_GLYPH: Partial<Record<PrAttention, PrCornerGlyphKind>> = {
  conflict: 'conflict',
  ciFailed: 'ciFailed',
  changesRequested: 'changesRequested',
  ciRunning: 'ciRunning',
  approvedBlocked: 'approvedBlocked',
  ready: 'ready',
};

const spin = keyframes({ from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } });

function Corner({
  kind,
  corner,
  size,
  color,
  offset = 0,
}: {
  kind: PrCornerGlyphKind;
  corner: 'bottomRight' | 'topLeft';
  size: number;
  color: string;
  offset?: number;
}) {
  const edge = -Math.round(size / 3);
  const position = corner === 'bottomRight' ? { right: edge, bottom: edge } : { left: edge + offset, top: edge };
  return (
    <Box
      data-pr-glyph={kind}
      sx={{
        position: 'absolute',
        ...position,
        display: 'flex',
        borderRadius: '50%',
        // Cuts the mark out of the PR glyph's lines so it stays legible at this size.
        bgcolor: 'background.surface',
        color,
        ...(kind === 'ciRunning' && {
          animation: `${spin} 1200ms linear infinite`,
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }),
      }}
    >
      <PrCornerGlyph kind={kind} size={size} />
    </Box>
  );
}

/**
 * The PR glyph in its state's colour, plus a bottom-right mark for what an open PR waits on and
 * top-left marks for behind-base and auto-merge. `data-pr-color` carries the resolved colour so a
 * test can hold the bar and the sidebar to the same one; class-hashed styles cannot be compared.
 */
export function PrStateIcon({
  status: given,
  size = 16,
  label,
  testId,
}: {
  /**
   * A bare state is for a caller that only knows the lifecycle (the orchestrator's agent chip):
   * it keeps the plain state colour rather than reading as "attention unknown".
   */
  status: PrIconStatus | PrDisplayState;
  size?: number;
  /** Hover and screen-reader text; leave it off where a parent already names the PR (the sidebar badge). */
  label?: string;
  testId?: string;
}) {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const status: PrIconStatus = typeof given === 'string' ? { state: given } : given;
  const color = typeof given === 'string' ? prStateColor(given, mode) : prIconColor(given, mode);
  const Icon = ICONS[status.state];
  const open = status.state === 'open';
  const glyph = open && status.attention ? ATTENTION_GLYPH[status.attention] : undefined;
  const corner = Math.max(6, Math.round(size * 0.55));
  const badge = Math.max(5, Math.round(size * 0.45));
  return (
    <Box
      sx={{ position: 'relative', display: 'flex', color, opacity: iconOpacity(status), flexShrink: 0 }}
      data-testid={testId}
      data-pr-state={status.state}
      data-pr-color={color}
      data-pr-attention={open ? status.attention : undefined}
      data-pr-behind={open && status.behind ? 'true' : undefined}
      data-pr-auto-merge={open && status.autoMerge ? 'true' : undefined}
      data-pr-stale={status.stale ? 'true' : undefined}
      {...(label ? { title: label, 'aria-label': label, role: 'img' } : {})}
    >
      <Icon size={size} />
      {glyph && <Corner kind={glyph} corner="bottomRight" size={corner} color={color} />}
      {open && status.behind && <Corner kind="behind" corner="topLeft" size={badge} color="text.secondary" />}
      {open && status.autoMerge && (
        <Corner
          kind="autoMerge"
          corner="topLeft"
          size={badge}
          color="primary.plainColor"
          offset={status.behind ? badge : 0}
        />
      )}
    </Box>
  );
}
