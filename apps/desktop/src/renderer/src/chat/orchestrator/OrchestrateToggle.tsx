import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Tooltip from '@mui/joy/Tooltip';
import { keyframes } from '@mui/system';
import { useEffect, useRef, type ReactNode } from 'react';
import { AgentsIcon, ConversationIcon } from '../icons';
import { isMac } from '../platform';
import type { SessionSurface } from './orchestratorPrefs';
import { AGENT_STATE_LABEL, AGENT_STATE_PRIORITY, type AgentState } from './roster';

interface OrchestrateToggleProps {
  /** One entry per agent; states only, so the chat surface never subscribes to agent activity. */
  states: readonly AgentState[];
  surface: SessionSurface;
  onSurfaceChange(surface: SessionSurface): void;
  /** A Code session, which can start orchestrating before it has any agents. */
  canStart: boolean;
  /** From the chip of an agentless session: turn Orchestrate on and show its surface. */
  onStart(): void;
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

/** "4 agents: 1 needs you, 2 working, 1 done", most urgent first; idle and stopped count as done. */
export function describeAgentStates(states: readonly AgentState[]): string {
  if (states.length === 0) return 'No agents yet';
  const counts = new Map<AgentState, number>();
  for (const state of states) {
    const bucket = state === 'idle' || state === 'stopped' ? 'done' : state;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const parts = AGENT_STATE_PRIORITY.filter(state => counts.has(state)).map(
    state => `${counts.get(state)} ${AGENT_STATE_LABEL[state].toLowerCase()}`
  );
  return `${states.length} ${states.length === 1 ? 'agent' : 'agents'}: ${parts.join(', ')}`;
}

function Segment({
  selected,
  label,
  hint,
  icon,
  testId,
  onClick,
  children,
}: {
  selected: boolean;
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
        aria-pressed={selected}
        variant={selected ? 'soft' : 'plain'}
        color={selected ? 'primary' : 'neutral'}
        startDecorator={icon}
        onClick={onClick}
        data-testid={testId}
        sx={{
          gap: 0.75,
          ...(selected && { bgcolor: 'background.surface', boxShadow: 'sm' }),
        }}
      >
        {label}
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * Header switch between the orchestrating conversation and its agents' stage; absent for a Chat
 * session that has spawned no agents. Styled like the sidebar's ModeSwitcher so the two read as one family.
 */
export function OrchestrateToggle({ states, surface, onSurfaceChange, canStart, onStart }: OrchestrateToggleProps) {
  const available = states.length > 0 || canStart;

  const select = (next: SessionSurface) => {
    if (next === surface) return;
    // An agentless Code session has no stage to switch to until Orchestrate is turned on.
    if (next === 'orchestrate' && states.length === 0) onStart();
    else onSurfaceChange(next);
  };

  const latest = useRef({ select, surface, available });
  latest.current = { select, surface, available };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSurfaceToggleKey(event) || !latest.current.available) return;
      event.preventDefault();
      latest.current.select(latest.current.surface === 'chat' ? 'orchestrate' : 'chat');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!available) return null;

  const needsYou = states.includes('needs-you');
  const failed = !needsYou && states.includes('failed');
  const working = !needsYou && !failed && states.includes('working');
  const badgeColor = needsYou ? 'warning' : failed ? 'danger' : 'neutral';

  return (
    <Box
      role="group"
      aria-label="Show the conversation or its agents"
      data-testid="chat-surface-toggle"
      sx={{ display: 'inline-flex', gap: 0.25, p: 0.25, borderRadius: 'sm', bgcolor: 'background.level2' }}
    >
      <Segment
        selected={surface === 'chat'}
        label="Conversation"
        hint={`The orchestrating conversation \u00B7 ${SHORTCUT_HINT}`}
        icon={<ConversationIcon />}
        testId="chat-surface-toggle-chat"
        onClick={() => select('chat')}
      />
      <Segment
        selected={surface === 'orchestrate'}
        label="Agents"
        hint={`${describeAgentStates(states)} \u00B7 ${SHORTCUT_HINT}`}
        icon={<AgentsIcon />}
        testId="chat-surface-toggle-orchestrate"
        onClick={() => select('orchestrate')}
      >
        {working && (
          <Box
            aria-hidden
            data-testid="chat-orchestrate-working"
            sx={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, bgcolor: 'primary.solidBg' }}
          />
        )}
        {states.length > 0 && (
          <Box
            component="span"
            data-testid="chat-orchestrate-count"
            data-tone={badgeColor}
            aria-label={describeAgentStates(states)}
            sx={{
              px: 0.75,
              borderRadius: 'lg',
              fontSize: 'xs',
              lineHeight: '16px',
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
        )}
      </Segment>
    </Box>
  );
}
