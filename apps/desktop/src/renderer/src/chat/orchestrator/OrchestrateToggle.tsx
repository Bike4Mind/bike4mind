import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import type { SessionSurface } from './orchestratorPrefs';
import type { AgentView } from './roster';

interface OrchestrateToggleProps {
  agents: readonly AgentView[];
  surface: SessionSurface;
  onSurfaceChange(surface: SessionSurface): void;
}

/** Header entry point into orchestrate mode; absent for a session that has spawned no agents. */
export function OrchestrateToggle({ agents, surface, onSurfaceChange }: OrchestrateToggleProps) {
  if (agents.length === 0) return null;

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

  const needsYou = agents.some(agent => agent.state === 'needs-you');
  const busy = needsYou || agents.some(agent => agent.state === 'working');

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
      {`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${busy ? ' working' : ''} \u00B7 Orchestrate`}
    </Chip>
  );
}
