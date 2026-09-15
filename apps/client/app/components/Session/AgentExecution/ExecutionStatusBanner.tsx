/**
 * ExecutionStatusBanner - high-level status indicator for an in-flight agent
 * execution. Pairs with `CreditCounter` to give the user an at-a-glance summary
 * of "the agent is still working" + "this is what it's cost so far".
 *
 * Mounted by `ActiveAgentExecutions` above each `IterationStream`. The chip
 * inside `IterationStream` reports the same status with per-iteration detail;
 * this banner is the user-facing summary, and crucially the only signal during
 * the gap between mount-time reconnect and the first new `iteration_step`
 * event - when the store has been hydrated with a status + iteration count but
 * no iteration data has streamed yet.
 *
 * Hidden when:
 *   - execution has no entry in the store
 *   - status is terminal (completed / failed / aborted)
 *   - status is `awaiting_permission` - `PermissionCard` already commands
 *     the user's attention and the banner would be redundant noise
 */

import { FC } from 'react';
import { Stack, Typography } from '@mui/joy';
import { useShallow } from 'zustand/react/shallow';
import { useAgentExecutionStore } from '@client/app/stores/useAgentExecutionStore';

interface ExecutionStatusBannerProps {
  executionId: string;
}

const ExecutionStatusBanner: FC<ExecutionStatusBannerProps> = ({ executionId }) => {
  // Subscribe narrowly: the banner only displays `status` and
  // `lastKnownIteration`, but `appendIteration` produces a new execution
  // object on every `iteration_step` event. Without `useShallow` on a
  // primitive-only projection, the banner would re-render on every step
  // (10+ Hz during heavy runs) for no visible change.
  const fields = useAgentExecutionStore(
    useShallow(state => {
      const exec = state.executions[executionId];
      if (!exec) return null;
      return { status: exec.status, lastKnownIteration: exec.lastKnownIteration };
    })
  );

  if (!fields) return null;
  const { status, lastKnownIteration } = fields;

  // Permission card owns the screen real estate when a tool is awaiting
  // approval; banner stays hidden to avoid double-messaging the user.
  if (status === 'awaiting_permission') return null;
  if (status === 'completed' || status === 'failed' || status === 'aborted') return null;

  // Iteration counter is 1-indexed for users (server counts from 0). Default
  // to 1 during the dispatch gap (status=pending, no iterations yet) so the
  // copy reads naturally - "iteration 1" is a more honest framing than
  // "iteration 0" for a run that's just been kicked off.
  const displayIteration = Math.max(1, lastKnownIteration + 1);

  const label = status === 'paused' ? 'Agent paused' : `Agent running — iteration ${displayIteration}`;

  return (
    <Stack
      data-testid={`execution-status-banner-${executionId}`}
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{ color: 'text.secondary' }}
    >
      <Typography level="body-sm">{label}</Typography>
    </Stack>
  );
};

export default ExecutionStatusBanner;
