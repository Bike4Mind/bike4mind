import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import { useTheme } from '@mui/joy/styles';
import Tooltip from '@mui/joy/Tooltip';
import { keyframes } from '@mui/system';
import { useEffect, useRef, type ReactNode } from 'react';
import { AgentStageIcon, ConversationIcon } from '../icons';
import { isMac } from '../platform';
import type { SessionSurface } from './orchestratorPrefs';
import { describeAgentStates, type AgentState } from './roster';

interface OrchestrateToggleProps {
  /** One entry per agent; states only, so the chat surface never subscribes to agent activity. */
  states: readonly AgentState[];
  /** The orchestrating session itself waits on the user: counted as the Tavern counts it. */
  parentNeedsYou?: boolean;
  surface: SessionSurface;
  onSurfaceChange(surface: SessionSurface): void;
}

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
`;

const SHORTCUT_HINT = isMac ? '\u2318\u21E7O' : 'Ctrl+Shift+O';

/** Mod+Shift+O, by `code` so it holds on any keyboard layout. */
export function isSurfaceToggleKey(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>) {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return mod && event.shiftKey && !event.altKey && event.code === 'KeyO';
}

function Segment({
  selected,
  raisedBg,
  label,
  hint,
  icon,
  testId,
  onClick,
  children,
}: {
  selected: boolean;
  /** The selected segment's fill: one step lighter than the track in either scheme. */
  raisedBg: string;
  label: string;
  hint: string;
  icon: ReactNode;
  testId: string;
  onClick(): void;
  children?: ReactNode;
}) {
  return (
    <Tooltip title={hint} size="sm" variant="soft" placement="bottom">
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        aria-label={label}
        aria-pressed={selected}
        onClick={onClick}
        data-testid={testId}
        sx={{
          minHeight: 26,
          px: 0.75,
          gap: 0.5,
          color: selected ? 'text.primary' : 'text.tertiary',
          '& svg': { width: 14, height: 14 },
          ...(selected && { bgcolor: raisedBg, boxShadow: 'xs', '&:hover': { bgcolor: raisedBg } }),
        }}
      >
        {icon}
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * Header switch between the conversation and its agents' stage, sized like the sidebar's ModeSwitcher.
 * View only: the Orchestrate behaviour is the composer's OrchestratePill, which is why this one draws
 * AgentStageIcon rather than its AgentsIcon. Absent until the session has an agent: an empty stage is
 * nothing to navigate to. The conversation segment stays icon-only, since "Chat" already names the
 * sidebar's Chat/Code mode and would misread in a Code session.
 */
export function OrchestrateToggle({ states, parentNeedsYou = false, surface, onSurfaceChange }: OrchestrateToggleProps) {
  const dark = useTheme().palette.mode === 'dark';
  const available = states.length > 0;

  const select = (next: SessionSurface) => {
    if (next !== surface) onSurfaceChange(next);
  };

  const latest = useRef({ select, surface, available });
  latest.current = { select, surface, available };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isSurfaceToggleKey(event) || !latest.current.available) return;
      event.preventDefault();
      latest.current.select(latest.current.surface === 'chat' ? 'orchestrate' : 'chat');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!available) return null;

  const needsYou = parentNeedsYou || states.includes('needs-you');
  const failed = !needsYou && states.includes('failed');
  const working = !needsYou && !failed && states.includes('working');
  const raisedBg = dark ? 'background.level2' : 'background.surface';
  const badgeColor = needsYou ? 'warning' : failed ? 'danger' : 'neutral';
  const description = describeAgentStates(states, parentNeedsYou ? 1 : 0);

  return (
    <Box
      role="group"
      aria-label="Conversation or agents view"
      data-testid="chat-surface-toggle"
      // Dark inverts Joy's ramp (surface is darker than level1), so the track and the raised fill swap.
      sx={{
        display: 'inline-flex',
        flexShrink: 0,
        gap: 0.25,
        p: '2px',
        borderRadius: 'sm',
        bgcolor: dark ? 'background.level1' : 'background.level2',
      }}
    >
      <Segment
        selected={surface === 'chat'}
        raisedBg={raisedBg}
        label="Show conversation"
        hint={`Show conversation \u00B7 ${SHORTCUT_HINT}`}
        icon={<ConversationIcon />}
        testId="chat-surface-toggle-chat"
        onClick={() => select('chat')}
      />
      <Segment
        selected={surface === 'orchestrate'}
        raisedBg={raisedBg}
        label={`Show agents, ${description}`}
        hint={`Show agents (${description}) \u00B7 ${SHORTCUT_HINT}`}
        icon={<AgentStageIcon />}
        testId="chat-surface-toggle-orchestrate"
        onClick={() => select('orchestrate')}
      >
        <Box component="span" data-testid="chat-orchestrate-label" sx={{ fontSize: 'xs', lineHeight: 1 }}>
          Agents
        </Box>
        {working && (
          <Box
            aria-hidden
            data-testid="chat-orchestrate-working"
            sx={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, bgcolor: 'primary.solidBg' }}
          />
        )}
        <Box
          component="span"
          data-testid="chat-orchestrate-count"
          data-tone={badgeColor}
          aria-hidden
          sx={{
            px: 0.625,
            borderRadius: 'lg',
            fontSize: '11px',
            lineHeight: '15px',
            bgcolor: `${badgeColor}.${needsYou ? 'solidBg' : 'softBg'}`,
            color: `${badgeColor}.${needsYou ? 'solidColor' : 'softColor'}`,
            ...(needsYou && {
              animation: `${pulse} 1.6s ease-in-out infinite`,
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            }),
          }}
        >
          {states.length}
        </Box>
      </Segment>
    </Box>
  );
}
