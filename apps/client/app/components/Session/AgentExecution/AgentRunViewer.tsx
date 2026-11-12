/**
 * Live view of one agent run by id, for a run this tab did not start (e.g. a loop's headless
 * run). Subscribes over the WS (`subscribe` in `server/websocket/agentExecute.ts`) and renders
 * the same `IterationStream` the chat uses; the snapshot fills in earlier steps.
 */
import { FC, useEffect, useRef } from 'react';
import { CircularProgress, Stack, Typography } from '@mui/joy';
import { Link } from '@tanstack/react-router';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';
import { isActiveStatus, useAgentExecutionStore } from '@client/app/stores/useAgentExecutionStore';
import { AGENT_TRACE_ROUTE, buildAgentTraceSearch } from '@client/app/utils/agentTraceLink';
import IterationStream from './IterationStream';

interface AgentRunViewerProps {
  executionId: string;
}

const AgentRunViewer: FC<AgentRunViewerProps> = ({ executionId }) => {
  const { readyState } = useWebsocket();
  const dispatch = useAgentExecutionDispatch();
  // Read through a ref: the dispatcher's identity churns on token refresh, which must not re-subscribe.
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const viewed = useAgentExecutionStore(state => state.viewedExecutionIds[executionId]);
  const hasExecution = useAgentExecutionStore(state => !!state.executions[executionId]);
  // A found run whose snapshot steps have not arrived yet would otherwise render as an empty frame.
  const awaitingSteps = useAgentExecutionStore(state => {
    const execution = state.executions[executionId];
    return !!execution && execution.iterations.length === 0 && isActiveStatus(execution.status);
  });

  useEffect(() => () => dispatchRef.current.unsubscribe(executionId), [executionId]);

  // Also on every socket-up: a reconnected socket has a new connection id, and the global
  // sweep only re-asks for runs that already have a store entry.
  useEffect(() => {
    if (readyState === ReadyState.OPEN) dispatchRef.current.subscribe(executionId);
  }, [executionId, readyState]);

  const loading = (
    <Stack
      data-testid="agent-run-viewer-loading"
      direction="row"
      spacing={1}
      sx={{ alignItems: 'center', justifyContent: 'center', py: 4 }}
    >
      <CircularProgress size="sm" />
      <Typography level="body-sm">Loading run...</Typography>
    </Stack>
  );

  let body;
  if (viewed === 'not_found') {
    body = (
      <Typography data-testid="agent-run-viewer-not-found" level="body-md" sx={{ py: 4, textAlign: 'center' }}>
        Run not found
      </Typography>
    );
  } else if (!hasExecution || viewed === 'pending') {
    body = loading;
  } else {
    // The stream still renders under the loader, so a just-started run keeps its abort and gate controls.
    body = (
      <>
        {awaitingSteps && loading}
        <IterationStream executionId={executionId} />
      </>
    );
  }

  return (
    <Stack data-testid="agent-run-viewer" spacing={2}>
      {body}
      {viewed !== 'not_found' && (
        <Typography level="body-sm">
          <Link
            to={AGENT_TRACE_ROUTE}
            search={buildAgentTraceSearch(executionId)}
            data-testid="agent-run-viewer-history-link"
          >
            Open in run history
          </Link>
        </Typography>
      )}
    </Stack>
  );
};

export default AgentRunViewer;
