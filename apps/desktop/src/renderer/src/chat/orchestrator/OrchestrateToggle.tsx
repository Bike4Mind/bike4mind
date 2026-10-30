import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import type { SessionSurface } from './orchestratorPrefs';
import type { AgentState } from './roster';

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

/** Header entry point into orchestrate mode; absent for a Chat session that has spawned no agents. */
export function OrchestrateToggle({ states, surface, onSurfaceChange, canStart, onStart }: OrchestrateToggleProps) {
  if (states.length === 0 && !canStart) return null;

  if (surface === 'orchestrate') {
    return (
      <ToggleButtonGroup
        size="sm"
        value={surface}
        onChange={(_event, next: SessionSurface | null) => {
          if (next) onSurfaceChange(next);
        }}
      >
        <Button value="chat" data-testid="chat-surface-toggle-chat">
          Chat
        </Button>
        <Button value="orchestrate" data-testid="chat-surface-toggle-orchestrate">
          Orchestrate
        </Button>
      </ToggleButtonGroup>
    );
  }

  if (states.length === 0) {
    return (
      <Chip size="sm" variant="soft" color="neutral" data-testid="chat-orchestrate-chip" onClick={onStart}>
        Orchestrate
      </Chip>
    );
  }

  const needsYou = states.includes('needs-you');
  const busy = needsYou || states.includes('working');

  return (
    <Chip
      size="sm"
      variant="soft"
      color={needsYou ? 'warning' : 'neutral'}
      // On the root, so the label is queryable; Joy stretches the inner action button over it for clicks.
      data-testid="chat-orchestrate-chip"
      onClick={() => onSurfaceChange('orchestrate')}
      startDecorator={
        needsYou ? (
          <Box
            aria-hidden
            sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.solidBg', flexShrink: 0 }}
          />
        ) : undefined
      }
    >
      {`${states.length} ${states.length === 1 ? 'agent' : 'agents'}${busy ? ' working' : ''} \u00B7 Orchestrate`}
    </Chip>
  );
}
