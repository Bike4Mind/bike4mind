import Box from '@mui/joy/Box';
import type { ColorPaletteProp } from '@mui/joy/styles';
import Tooltip from '@mui/joy/Tooltip';
import { AGENT_STATE_LABEL, describeAgentStates, type AgentState } from '@shared/agentState';
import type { WatchOrchestration } from '@shared/watch';

// Matches AgentStateChip, so a dot reads the same colour as the stage's chip.
const DOT_COLOR: Record<AgentState, ColorPaletteProp> = {
  'needs-you': 'warning',
  working: 'primary',
  done: 'success',
  failed: 'danger',
  stopped: 'neutral',
  idle: 'neutral',
};

/** The tiny window: every orchestration as a cluster of state dots. A click opens it in the app. */
export function MiniStrip({
  orchestrations,
  onOpen,
}: {
  orchestrations: readonly WatchOrchestration[];
  onOpen(rootId: string): void;
}) {
  return (
    <Box
      data-testid="mini-strip"
      sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, minWidth: 0, overflowX: 'auto' }}
    >
      {orchestrations.map(orchestration => {
        const states = orchestration.agents.map(agent => agent.state);
        const label = `${orchestration.title}: ${describeAgentStates(states) || 'no agents yet'}`;
        return (
          <Tooltip key={orchestration.rootId} title={label} size="sm">
            <Box
              component="button"
              type="button"
              aria-label={label}
              onClick={() => onOpen(orchestration.rootId)}
              data-testid={`mini-strip-cluster-${orchestration.rootId}`}
              sx={{
                display: 'flex',
                gap: '3px',
                p: 0.5,
                border: 'none',
                borderRadius: 'sm',
                bgcolor: 'transparent',
                cursor: 'pointer',
                WebkitAppRegion: 'no-drag',
                '&:hover': { bgcolor: 'background.level1' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible' },
              }}
            >
              {orchestration.agents.map(agent => (
                <Box
                  key={agent.id}
                  aria-hidden
                  title={`${agent.title}: ${AGENT_STATE_LABEL[agent.state]}`}
                  sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: `${DOT_COLOR[agent.state]}.solidBg` }}
                />
              ))}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
