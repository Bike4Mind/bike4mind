import { FC } from 'react';
import { Chip, type ChipProps } from '@mui/joy';
import type { AgentExecutionStatus } from '@client/app/stores/useAgentExecutionStore';

interface StatusChipProps {
  status: AgentExecutionStatus;
}

const STATUS_COLORS: Record<AgentExecutionStatus, ChipProps['color']> = {
  pending: 'neutral',
  running: 'primary',
  continuing: 'primary',
  awaiting_permission: 'warning',
  awaiting_subagent: 'primary',
  awaiting_dag_children: 'primary',
  paused: 'warning',
  completed: 'success',
  failed: 'danger',
  aborted: 'neutral',
};

const STATUS_LABELS: Record<AgentExecutionStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  continuing: 'Running',
  awaiting_permission: 'Awaiting permission',
  awaiting_subagent: 'Awaiting subagent',
  awaiting_dag_children: 'Awaiting DAG children',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
};

const StatusChip: FC<StatusChipProps> = ({ status }) => (
  <Chip size="sm" variant="soft" color={STATUS_COLORS[status]} data-testid={`execution-status-${status}`}>
    {STATUS_LABELS[status]}
  </Chip>
);

export default StatusChip;
