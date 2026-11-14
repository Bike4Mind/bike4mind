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

export function AgentStateChip({
  state,
  preparing = false,
  muted = false,
  deciding = false,
}: {
  state: AgentState;
  preparing?: boolean;
  muted?: boolean;
  /** Waiting on a decision only the user can make. */
  deciding?: boolean;
}) {
  if (deciding) {
    return (
      <Chip size="sm" color={STATE_COLOR['needs-you']} variant="solid" data-testid="orchestrator-state-chip-decision">
        Needs your decision
      </Chip>
    );
  }
  if (state === 'working' && preparing) {
    return (
      <Chip size="sm" color={STATE_COLOR.working} variant="outlined" data-testid="orchestrator-state-chip-preparing">
        Preparing
      </Chip>
    );
  }
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
