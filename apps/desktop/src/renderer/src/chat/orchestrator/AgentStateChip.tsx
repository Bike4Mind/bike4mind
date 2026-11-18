import Chip from '@mui/joy/Chip';
import { AGENT_STATE_LABEL, type AgentState } from './roster';
import { stateJoyColor } from './statePalette';

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
      <Chip size="sm" color={stateJoyColor('needs-you')} variant="solid" data-testid="orchestrator-state-chip-decision">
        Needs your decision
      </Chip>
    );
  }
  if (state === 'working' && preparing) {
    return (
      <Chip
        size="sm"
        color={stateJoyColor('working')}
        variant="outlined"
        data-testid="orchestrator-state-chip-preparing"
      >
        Preparing
      </Chip>
    );
  }
  return (
    <Chip
      size="sm"
      color={stateJoyColor(state)}
      variant={muted ? 'outlined' : state === 'needs-you' ? 'solid' : 'soft'}
      data-testid={`orchestrator-state-chip-${state}`}
    >
      {AGENT_STATE_LABEL[state]}
    </Chip>
  );
}
