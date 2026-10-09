import Box from '@mui/joy/Box';
import { useTheme } from '@mui/joy/styles';
import type { PrDisplayState } from '@shared/pullRequest';
import { MergedIcon, PullRequestClosedIcon, PullRequestIcon } from './icons';

/**
 * How a PR's state is drawn, for both PrStatusBar and the sidebar's session rows. Neither picks
 * a colour or an icon of its own: a row's icon and its conversation's bar must always agree.
 */

/**
 * GitHub's merged purple for each mode. Joy's palette has no purple, and its nearest token
 * (primary blue) would read as "open", the opposite of what a merged bar should say.
 */
export const MERGED_COLOR = { light: '#8250df', dark: '#a371f7' } as const;

export type ThemeMode = 'light' | 'dark';

export const PR_STATE_LABEL: Record<PrDisplayState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

/** Joy palette tokens where the theme has the colour; see MERGED_COLOR for the one it lacks. */
export function prStateColor(state: PrDisplayState, mode: ThemeMode): string {
  switch (state) {
    case 'open':
      return 'success.plainColor';
    case 'draft':
      return 'text.tertiary';
    case 'merged':
      return MERGED_COLOR[mode];
    case 'closed':
      return 'danger.plainColor';
  }
}

/** A closed PR is muted: it is over, but unlike a merged one it did not land. */
export function prStateOpacity(state: PrDisplayState): number {
  return state === 'closed' ? 0.7 : 1;
}

const ICONS: Record<PrDisplayState, typeof PullRequestIcon> = {
  open: PullRequestIcon,
  draft: PullRequestIcon,
  merged: MergedIcon,
  closed: PullRequestClosedIcon,
};

/**
 * The PR glyph in its state's colour. `data-pr-color` carries the resolved colour so a test can
 * hold the bar and the sidebar to the same one; class-hashed styles cannot be compared directly.
 */
export function PrStateIcon({ state, size, testId }: { state: PrDisplayState; size?: number; testId?: string }) {
  const theme = useTheme();
  const color = prStateColor(state, theme.palette.mode === 'dark' ? 'dark' : 'light');
  const Icon = ICONS[state];
  return (
    <Box
      sx={{ display: 'flex', color, opacity: prStateOpacity(state), flexShrink: 0 }}
      data-testid={testId}
      data-pr-state={state}
      data-pr-color={color}
    >
      <Icon size={size} />
    </Box>
  );
}
