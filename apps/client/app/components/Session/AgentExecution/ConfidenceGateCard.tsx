/**
 * ConfidenceGateCard - inline Proceed/Stop prompt for a confidence-gate pause.
 *
 * When an iteration's confidence falls below the threshold the executor
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
  const setStatus = useAgentExecutionStore(s => s.setStatus);
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
      // Optimistic clear hides the card immediately; the server's next event
      // reconciles status (running on continue, completed on stop).
      setPendingGate(executionId, undefined);
      // Only Proceed resumes the run - Stop is about to land as `completed`,
      // so forcing `running` first would briefly mis-indicate progress.
      if (decision === 'continue') {
        setStatus(executionId, 'running');
      }
    },
    [executionId, respondToGate, setPendingGate, setStatus]
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
          // Same outlined frame as Proceed, but red text to signal the stop
          // action - mirrors `PermissionCard`'s Deny button.
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
