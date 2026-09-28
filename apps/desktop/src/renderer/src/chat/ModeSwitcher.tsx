import type { ReactElement } from 'react';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Tooltip from '@mui/joy/Tooltip';
import type { ChatSessionMode } from '@shared/chat';

/**
 * Inline SVG rather than an icon package: the desktop app ships no icon dependency, and these
 * two glyphs are the whole need. `currentColor` lets Joy's variant colours drive them.
 */
function ChatIcon() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      sx={{ width: 16, height: 16 }}
      aria-hidden
    >
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4.2-.9L3 20.5l1.6-4.4A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
    </Box>
  );
}

function CodeIcon() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      sx={{ width: 16, height: 16 }}
      aria-hidden
    >
      <path d="m9 17-5-5 5-5" />
      <path d="m15 7 5 5-5 5" />
    </Box>
  );
}

const MODES: { mode: ChatSessionMode; label: string; hint: string; icon: () => ReactElement }[] = [
  {
    mode: 'chat',
    label: 'Chat',
    hint: 'Chat: a conversation with tools, grounded in nothing in particular',
    icon: ChatIcon,
  },
  {
    mode: 'code',
    label: 'Code',
    hint: 'Code: conversations grounded in a project directory and branch',
    icon: CodeIcon,
  },
];

/**
 * The segmented control at the top-right of the title bar. It chooses what a new session WILL
 * be, and filters the sidebar to that mode - it never converts an open session, because a Code
 * session's working directory is what its tools have already been running in.
 */
export function ModeSwitcher({ mode, onChange }: { mode: ChatSessionMode; onChange: (mode: ChatSessionMode) => void }) {
  return (
    <Box
      role="group"
      aria-label="Session mode"
      sx={{
        display: 'flex',
        gap: 0.25,
        p: 0.25,
        borderRadius: 'sm',
        bgcolor: 'background.level2',
      }}
      data-testid="mode-switcher"
    >
      {MODES.map(({ mode: value, label, hint, icon: Icon }) => (
        <Tooltip key={value} title={hint} size="sm" variant="soft">
          <IconButton
            size="sm"
            aria-label={label}
            aria-pressed={mode === value}
            variant={mode === value ? 'solid' : 'plain'}
            color={mode === value ? 'primary' : 'neutral'}
            onClick={() => onChange(value)}
            data-testid={`mode-switch-${value}-btn`}
          >
            <Icon />
          </IconButton>
        </Tooltip>
      ))}
    </Box>
  );
}
