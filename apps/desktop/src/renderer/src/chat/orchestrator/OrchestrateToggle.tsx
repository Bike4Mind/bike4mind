import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
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

  const needsYou = states.includes('needs-you');
  const working = !needsYou && states.includes('working');

  const select = (next: SessionSurface) => {
    if (next === surface) return;
    // An agentless Code session has no stage to switch to until Orchestrate is turned on.
    if (next === 'orchestrate' && states.length === 0) onStart();
    else onSurfaceChange(next);
  };

  return (
    <ToggleButtonGroup
      size="sm"
      value={surface}
      onChange={(_event, next: SessionSurface | null) => {
        if (next) select(next);
      }}
    >
      <Button value="chat" data-testid="chat-surface-toggle-chat">
        Chat
      </Button>
      <Button value="orchestrate" data-testid="chat-surface-toggle-orchestrate" sx={{ gap: 0.75 }}>
        {(needsYou || working) && (
          <Box
            aria-hidden
            data-testid={needsYou ? 'chat-orchestrate-needs-you' : 'chat-orchestrate-working'}
            sx={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              flexShrink: 0,
              bgcolor: needsYou ? 'warning.solidBg' : 'primary.solidBg',
            }}
          />
        )}
        Orchestrate
        {states.length > 0 && (
          <Box
            component="span"
            data-testid="chat-orchestrate-count"
            aria-label={`${states.length} ${states.length === 1 ? 'agent' : 'agents'}`}
            sx={{
              px: 0.75,
              borderRadius: 'lg',
              fontSize: 'xs',
              lineHeight: '16px',
              bgcolor: needsYou ? 'warning.softBg' : 'neutral.softBg',
              color: needsYou ? 'warning.softColor' : 'neutral.softColor',
            }}
          >
            {states.length}
          </Box>
        )}
      </Button>
    </ToggleButtonGroup>
  );
}
