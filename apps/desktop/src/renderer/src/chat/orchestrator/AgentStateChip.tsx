import Chip from '@mui/joy/Chip';
import type { ColorPaletteProp } from '@mui/joy/styles';
import { AGENT_STATE_LABEL, type AgentState } from './roster';

const STATE_COLOR: Record<AgentState, ColorPaletteProp> = {
  'needs-you': 'warning',
  working: 'primary',
  done: 'success',
  failed: 'danger',
  stopped: 'neutral',
  idle: 'neutral',
};

export function AgentStateChip({ state, muted = false }: { state: AgentState; muted?: boolean }) {
  return (
    <Chip
      size="sm"
      color={STATE_COLOR[state]}
      variant={muted ? 'outlined' : state === 'needs-you' ? 'solid' : 'soft'}
      data-testid={`orchestrator-state-chip-${state}`}
    >
      {AGENT_STATE_LABEL[state]}
    </Chip>
  );
}
