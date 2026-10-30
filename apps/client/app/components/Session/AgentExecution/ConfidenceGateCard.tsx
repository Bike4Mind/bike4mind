/**
 * ConfidenceGateCard - inline Proceed/Stop prompt for a confidence-gate pause.
 *
 * When consecutive iterations' confidence falls below the threshold the executor
 * persists `pendingGate`, flips the run to `paused`, emits `confidence_gate`,
 * and exits, holding the run's concurrent slot. This card is the only way to
 * release it: Proceed dispatches `gate_response: continue` and the run resumes,
 * Stop dispatches `gate_response: stop` and the server completes the run with
 * the partial answer.
 *
 * The card self-gates on `pendingGate` presence, exactly as `PermissionCard`
 * does on `pendingPermission`, so `IterationStream` mounts it unconditionally
 * and a reconnect (`reconnect_result.pendingGate`) re-renders it for free.
 */

import { FC, useCallback, useEffect, useRef } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/joy';
import { useAgentExecutionStore, selectExecution } from '@client/app/stores/useAgentExecutionStore';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';

interface ConfidenceGateCardProps {
  executionId: string;
}

const ConfidenceGateCard: FC<ConfidenceGateCardProps> = ({ executionId }) => {
  const pendingGate = useAgentExecutionStore(state => selectExecution(executionId)(state)?.pendingGate);
  const setPendingGate = useAgentExecutionStore(s => s.setPendingGate);
  const { respondToGate } = useAgentExecutionDispatch();

  // Same double-click guard as `PermissionCard`: Zustand clears the gate
  // synchronously but React re-renders on the next tick, so a second click in
  // that gap would send a conflicting `gate_response`. Keyed on `requestedAt`
  // so the guard resets for each new pause - the parent execution outlives the
  // card, so a latching guard would swallow every click after the first pause.
  const responding = useRef(false);
  useEffect(() => {
    responding.current = false;
  }, [pendingGate?.requestedAt]);

  const handleRespond = useCallback(
    (decision: 'continue' | 'stop') => {
      if (responding.current) return;
      responding.current = true;
      respondToGate(executionId, decision);
      // Optimistic clear hides the card immediately. Status is left alone on
      // purpose: only a server frame may claim the run is live again - a forced
      // `running` here would paint "In Progress" over a pause the server has
      // already swept. `respondToGate` re-asks for the real status if no frame
      // follows, and the executor's `resumed` frame is what resumes the chip.
      setPendingGate(executionId, undefined);
    },
    [executionId, respondToGate, setPendingGate]
  );

  if (!pendingGate) return null;

  return (
    <Alert
      data-testid={`confidence-gate-card-${executionId}`}
      color="warning"
      variant="soft"
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2, mt: 1, p: 2 }}
    >
      <Typography level="title-sm" sx={{ color: 'text.primary', fontSize: '16px' }}>
        Paused at iteration {pendingGate.iteration + 1} - Proceed?
      </Typography>
      <Typography level="body-sm" sx={{ color: 'text.primary' }}>
        {pendingGate.reason}
      </Typography>
      <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap' }}>
        <Button
          data-testid={`confidence-gate-proceed-${executionId}`}
          color="success"
          size="sm"
          onClick={() => handleRespond('continue')}
        >
          Proceed
        </Button>
        <Button
          data-testid={`confidence-gate-stop-${executionId}`}
          variant="outlined"
          color="neutral"
          size="sm"
          // Mirrors `PermissionCard`'s Deny: outlined frame from Joy's default
          // styling, red text, body background.
          sx={{
            borderRadius: '6px',
            backgroundColor: 'var(--joy-palette-background-body) !important',
            '&:hover': { backgroundColor: 'var(--joy-palette-background-surface2) !important' },
            '--variant-outlinedColor': 'var(--joy-palette-danger-outlinedColor)',
          }}
          onClick={() => handleRespond('stop')}
        >
          Stop
        </Button>
      </Stack>
    </Alert>
  );
};

export default ConfidenceGateCard;
