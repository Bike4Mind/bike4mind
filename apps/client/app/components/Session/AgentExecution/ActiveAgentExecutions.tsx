/**
 * ActiveAgentExecutions - renders one IterationStream for each in-flight or
 * recently-finished agent execution in the current session.
 *
 * Mounted by SessionContainer above SessionBottom so the iteration stream
 * appears between the chat history and the input bar. Executions are scoped
 * by sessionId so unrelated parallel runs in other sessions don't bleed in.
 *
 * Active runs always render. Completed/failed/aborted runs linger so the
 * user sees the final answer/error without needing scrollback; the next
 * dispatch in the same session evicts stale entries via
 * `clearForSession(sessionId)` from the send-message hook.
 */

import { FC, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Box } from '@mui/joy';
import { useAgentExecutionStore, selectExecutionIdsForSession } from '@client/app/stores/useAgentExecutionStore';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';
import ReplyStatus from '@client/app/components/common/ReplyStatus';
import IterationStream from './IterationStream';
import { STARTING_COPY } from './loadingCopy';
import { useRotatingCopy } from './useRotatingCopy';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);

interface ActiveAgentExecutionsProps {
  sessionId: string | null | undefined;
}

const ActiveAgentExecutions: FC<ActiveAgentExecutionsProps> = ({ sessionId }) => {
  const { reconnect } = useAgentExecutionDispatch();

  // Mount-time reconnect: on session change, ask the server whether
  // an in-flight execution exists for this session. The server replies with
  // `reconnect_result`, which the subscriber pipes into the store via
  // `hydrateFromReconnect` - that stamps the sessionId onto the execution so
  // it shows up below. No-op when `found: false`.
  //
  // The reconnect effect depends ONLY on `sessionId`. `reconnect` is read
  // through a ref because the dispatcher's identity is stable today
  // (memoised over `sendJsonMessage`) but a future upstream change could
  // make it churn - putting `reconnect` in the deps would then fire
  // reconnect on every render, each call enqueueing another
  // `pendingReconnects` entry and scrambling the FIFO matching with
  // `reconnect_result` events. The sync effect keeps the ref current
  // without writing during render.
  const reconnectRef = useRef(reconnect);
  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);
  useEffect(() => {
    if (!sessionId) return;
    reconnectRef.current(sessionId);
  }, [sessionId]);

  // Memoize the selector factory so its identity is stable across renders -
  // otherwise zustand re-runs the scan+sort on every store change (e.g. each
  // `iteration_step`), even though `useShallow` keeps the output stable.
  const selector = useMemo(() => selectExecutionIdsForSession(sessionId), [sessionId]);
  const executionIds = useAgentExecutionStore(useShallow(selector));

  // Only render iteration streams for ACTIVE runs. Once a run reaches a
  // terminal state, the persisted Quest (server-side, see persistRunAsQuest
  // in agentExecutor.ts) takes over rendering inside the normal chat history
  // - the final answer shows up as a regular Quest reply bubble. Keeping the
  // iteration stream mounted after completion produced a redundant render
  // (chat bubble + completed iteration block) and confused the visual flow.
  //
  // The iteration data stays in the Zustand store for the session so a future
  // "show reasoning" disclosure on the Quest bubble can re-mount it on
  // demand without re-fetching.
  const activeExecutionIds = useAgentExecutionStore(
    useShallow(state =>
      executionIds.filter(id => {
        const status = state.executions[id]?.status;
        return status && !TERMINAL_STATUSES.has(status);
      })
    )
  );

  // Has the user dispatched a run that hasn't received `execution_started`
  // yet? The dispatcher enqueues the sessionId via `registerPendingDispatch`
  // and the server's first WS event (`execution_started`) consumes it.
  // Between those two points there's no execution entry to render - without
  // this guard the UI sits silent and looks stuck. The server can take
  // 1-5s+ to spin up the Lambda, so this gap is user-visible.
  const isAwaitingDispatch = useAgentExecutionStore(
    state => !!sessionId && state.pendingDispatches.includes(sessionId)
  );

  if (!sessionId) return null;

  // If there's an active execution to render, use the iteration stream UI -
  // the dispatch placeholder is only for the pre-execution_started gap.
  if (activeExecutionIds.length > 0) {
    return (
      <Box data-testid="active-agent-executions" sx={{ display: 'flex', flexDirection: 'column', gap: 2, px: 2 }}>
        {/* Status (incl. current iteration) and the credits counter now live
            inside IterationStream's own framed header - no separate banner row
            above the frame. */}
        {activeExecutionIds.map(id => (
          <IterationStream key={id} executionId={id} />
        ))}
      </Box>
    );
  }

  // Dispatch gap - show a slim "Starting..." indicator so the user has
  // immediate feedback that their message reached the system.
  if (isAwaitingDispatch) {
    return <StartingPlaceholder />;
  }

  return null;
};

// Extracted so the rotating-copy hook is unconditional. Reuses ReplyStatus (the
// bicycle-wheel spinner from the normal prompt-send flow), centered, so the
// dispatch wait matches the main chat loading indicator instead of a bespoke
// mini-spinner. Rotating copy feeds ReplyStatus's status label.
const StartingPlaceholder: FC = () => {
  const copy = useRotatingCopy(STARTING_COPY);
  return (
    <Box
      data-testid="active-agent-executions-dispatching"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        py: 1,
      }}
    >
      <ReplyStatus status={copy} />
    </Box>
  );
};

export default ActiveAgentExecutions;
