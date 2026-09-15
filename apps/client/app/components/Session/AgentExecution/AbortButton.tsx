/**
 * AbortButton - sends `agent_execute` `abort` for an active execution.
 *
 * Hides itself once the execution reaches a terminal state. Once
 * `abort_acknowledged` (or `failed.reason='aborted'`) arrives, the store
 * transitions to `aborted` and the button disappears; the iteration stream
 * surfaces "Aborted at iteration N" via `IterationStream`.
 */

import { FC, useCallback } from 'react';
import { Button, CircularProgress } from '@mui/joy';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import {
  type AgentExecutionStatus,
  isActiveStatus,
  useAgentExecutionStore,
} from '@client/app/stores/useAgentExecutionStore';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';

interface AbortButtonProps {
  executionId: string;
  status: AgentExecutionStatus;
}

const AbortButton: FC<AbortButtonProps> = ({ executionId, status }) => {
  const { abort } = useAgentExecutionDispatch();
  // Optimistic "aborting" flag: the run keeps going server-side until it hits
  // its next abort-check boundary, so without this the click has no feedback.
  const isAborting = useAgentExecutionStore(s => s.executions[executionId]?.isAborting ?? false);
  const markAborting = useAgentExecutionStore(s => s.markAborting);

  const handleClick = useCallback(() => {
    markAborting(executionId);
    abort(executionId);
  }, [abort, markAborting, executionId]);

  if (!isActiveStatus(status)) {
    return null;
  }

  return (
    <Button
      data-testid={`agent-abort-${executionId}`}
      variant="outlined"
      color="danger"
      size="sm"
      onClick={handleClick}
      disabled={isAborting}
      startDecorator={
        isAborting ? (
          <CircularProgress size="sm" sx={{ '--CircularProgress-size': '16px' }} />
        ) : (
          <StopCircleOutlinedIcon />
        )
      }
    >
      {isAborting ? 'Stopping…' : 'Stop'}
    </Button>
  );
};

export default AbortButton;
