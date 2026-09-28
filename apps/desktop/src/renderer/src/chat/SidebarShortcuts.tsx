import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { QUICK_SWITCH_LIMIT } from './grouping';

/** Cmd on macOS, Ctrl everywhere else - matched to what the key handler actually accepts. */
const MODIFIER = navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl';

const SHORTCUTS: [string, string][] = [
  [`${MODIFIER} 1-${QUICK_SWITCH_LIMIT}`, 'Jump to a numbered conversation'],
  [`${MODIFIER} B`, 'Show or hide the sidebar'],
];

/** What the numbers on the first nine rows are for, since nothing else on screen says so. */
export function SidebarShortcuts() {
  return (
    <Stack spacing={0.5} data-testid="sidebar-shortcuts">
      {SHORTCUTS.map(([keys, meaning]) => (
        <Stack key={keys} direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
          <Typography level="body-xs" fontFamily="monospace" sx={{ flexShrink: 0 }}>
            {keys}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>
            {meaning}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
