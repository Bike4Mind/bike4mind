/**
 * AbortButton - sends `agent_execute` `abort` for an active execution.
 *
 * Hides itself once the execution reaches a terminal state. Once
 * `abort_acknowledged` (or `failed.reason='aborted'`) arrives, the store
 * transitions to `aborted` and the button disappears; the iteration stream
 * surfaces "Aborted at iteration N" via `IterationStream`.
 */

import { FC, useCallback } from 'react';
import { Button } from '@mui/joy';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import { type AgentExecutionStatus, isActiveStatus } from '@client/app/stores/useAgentExecutionStore';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';

interface AbortButtonProps {
  executionId: string;
  status: AgentExecutionStatus;
}

const AbortButton: FC<AbortButtonProps> = ({ executionId, status }) => {
  const { abort } = useAgentExecutionDispatch();

  const handleClick = useCallback(() => {
    abort(executionId);
  }, [abort, executionId]);

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
      startDecorator={<StopCircleOutlinedIcon />}
    >
      Stop
    </Button>
  );
};

export default AbortButton;
