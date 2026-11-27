import Chip from '@mui/joy/Chip';
import { AGENT_STATE_LABEL, type AgentState } from './roster';
import { stateJoyColor, stateSkinSx } from './statePalette';

export function AgentStateChip({
  state,
  preparing = false,
  muted = false,
  deciding = false,
  backgroundJobs,
}: {
  state: AgentState;
  preparing?: boolean;
  muted?: boolean;
  /** Waiting on a decision only the user can make. */
  deciding?: boolean;
  /** Running background jobs a 'waiting' agent waits on, spelled out beside the label. */
  backgroundJobs?: number;
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
        sx={stateSkinSx('working', 'outlined')}
        data-testid="orchestrator-state-chip-preparing"
      >
        Preparing
      </Chip>
    );
  }
  const variant = muted ? 'outlined' : state === 'needs-you' ? 'solid' : 'soft';
  return (
    <Chip
      size="sm"
      color={stateJoyColor(state)}
      variant={variant}
      sx={stateSkinSx(state, variant)}
      data-testid={`orchestrator-state-chip-${state}`}
    >
      {state === 'waiting' && backgroundJobs
        ? `${AGENT_STATE_LABEL[state]} - ${backgroundJobs} background ${backgroundJobs === 1 ? 'job' : 'jobs'}`
        : AGENT_STATE_LABEL[state]}
    </Chip>
  );
}
