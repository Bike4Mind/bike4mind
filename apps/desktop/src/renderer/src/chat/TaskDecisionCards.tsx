import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { PendingDecision, PendingTaskDecision, TaskDecisionAnswer } from '@shared/orchestration';
import { hostChat } from '../host/hostChat';
import { hostClient } from '../host/HostClient';
import { useServingHostIds } from '../host/hostRegistry';
import { useHostResync } from '../host/useSessionEvents';
import { contentColumnSx, scrollingColumnHostSx } from './layout';
import { QuestionCard } from './QuestionCard';
import { SessionLink } from './SessionLink';

function nextTicket(tickets: Map<string, number>, hostId: string): number {
  const ticket = (tickets.get(hostId) ?? 0) + 1;
  tickets.set(hostId, ticket);
  return ticket;
}

/**
 * Every decision workers wait on the user for, per connected host: read on mount, when a host
 * connects and after each resync, and replaced by each push of the whole list in between. A host
 * that disconnects takes its decisions with it, since they cannot be answered meanwhile. taskDecision/list needs a
 * 1.3 host, which the bundled one is; gate on the negotiated minor before a 1.2 host can be a peer.
 */
export function useTaskDecisions(): PendingTaskDecision[] {
  const servingHosts = useServingHostIds();
  const serving = useRef(servingHosts);
  serving.current = servingHosts;
  const [byHost, setByHost] = useState<ReadonlyMap<string, PendingTaskDecision[]>>(() => new Map());
  const set = useCallback(
    (hostId: string, list: PendingTaskDecision[]) => setByHost(current => new Map(current).set(hostId, list)),
    []
  );

  // Per host, the ticket of its latest read; a push bumps it too, since it is newer than any read
  // already on its way.
  const reads = useRef(new Map<string, number>());

  useEffect(
    () =>
      hostClient.onNotification('session/taskDecisionsChanged', ({ decisions }, hostId) => {
        if (!serving.current.includes(hostId)) return;
        nextTicket(reads.current, hostId);
        set(hostId, decisions);
      }),
    [set]
  );

  // Each host's list is read when it joins and after its own resync, never because another host
  // joined or left.
  const readHost = useCallback(
    (hostId: string) => {
      const ticket = nextTicket(reads.current, hostId);
      hostClient
        .request(hostId, 'taskDecision/list')
        .then(({ decisions }) => {
          if (reads.current.get(hostId) === ticket) set(hostId, decisions);
        })
        .catch(() => undefined);
    },
    [set]
  );

  useEffect(() => {
    const wanted = new Set(servingHosts);
    const gone = [...reads.current.keys()].filter(hostId => !wanted.has(hostId));
    for (const hostId of gone) reads.current.delete(hostId);
    setByHost(current => {
      const leaving = [...current.keys()].filter(hostId => !wanted.has(hostId));
      if (leaving.length === 0) return current;
      const next = new Map(current);
      for (const hostId of leaving) next.delete(hostId);
      return next;
    });
    for (const hostId of servingHosts) if (!reads.current.has(hostId)) readHost(hostId);
  }, [servingHosts, readHost]);

  useHostResync(hostId => {
    if (reads.current.has(hostId)) readHost(hostId);
  });

  useEffect(() => () => reads.current.clear(), []);

  return useMemo(() => [...byHost.values()].flat(), [byHost]);
}

/**
 * One worker's decision as an ask_user card. The same decision can be on screen twice (the root
 * conversation and the worker's own); main resolves both copies, and a stale one is a no-op.
 */
export function TaskDecisionCard({
  sessionId,
  title,
  decision,
  onOpenSession,
  onAnswered,
}: {
  sessionId: string;
  title: string;
  decision: PendingDecision;
  onOpenSession?: (sessionId: string) => void;
  onAnswered?(): void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (value: TaskDecisionAnswer) => {
    setSending(true);
    setError(null);
    try {
      await hostChat.answerTaskDecision(sessionId, decision.id, value);
      onAnswered?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSending(false);
    }
  };

  return (
    <Sheet
      variant="outlined"
      color="warning"
      sx={{ borderRadius: 'md', p: 1.25 }}
      data-testid="task-decision-card"
      data-session-id={sessionId}
      data-decision-id={decision.id}
    >
      <Stack spacing={0.75}>
        <Typography level="title-sm">
          {onOpenSession ? (
            <SessionLink sessionId={sessionId} testId="task-decision-agent-link" onOpen={onOpenSession}>
              {title}
            </SessionLink>
          ) : (
            title
          )}{' '}
          needs your decision
        </Typography>
        {error && (
          <Alert size="sm" color="danger" variant="soft" data-testid="task-decision-error">
            {error}
          </Alert>
        )}
        {sending ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="task-decision-sending">
            Sending your answer...
          </Typography>
        ) : (
          <QuestionCard
            key={decision.id}
            questions={[decision.question]}
            onSubmit={answers => void answer({ status: 'answered', answers })}
            onSkip={() => void answer({ status: 'skipped' })}
          />
        )}
      </Stack>
    </Sheet>
  );
}

/**
 * The tallest the list grows before it scrolls. The thread or Orchestrate stage above it is a
 * `minHeight: 0` flex item, so an uncapped stack of decisions would squeeze it to nothing.
 */
export const TASK_DECISION_LIST_MAX_HEIGHT = '40vh';

/** The decisions shown above a conversation's composer: asked by agents under it, and by it itself. */
export function decisionsFor(
  sessionId: string | null,
  decisions: readonly PendingTaskDecision[]
): readonly PendingTaskDecision[] {
  if (!sessionId) return [];
  return decisions.filter(entry => entry.rootId === sessionId || entry.sessionId === sessionId);
}

/** Above the composer: decisions asked by agents under this conversation, and by this conversation itself. */
export function TaskDecisionCards({
  sessionId,
  decisions,
  onOpenSession,
}: {
  sessionId: string | null;
  decisions: readonly PendingTaskDecision[];
  onOpenSession: (sessionId: string) => void;
}) {
  const shown = decisionsFor(sessionId, decisions);
  if (shown.length === 0) return null;
  return (
    <Box
      role="region"
      aria-label="Decisions waiting on you"
      // Focusable so the list can be scrolled from the keyboard once it overflows.
      tabIndex={0}
      sx={{
        ...scrollingColumnHostSx,
        flexShrink: 0,
        maxHeight: TASK_DECISION_LIST_MAX_HEIGHT,
        overscrollBehavior: 'contain',
      }}
      data-testid="task-decision-list"
    >
      <Stack spacing={0.75} sx={{ ...contentColumnSx, pt: 1.5 }}>
        {shown.map(entry => (
          <TaskDecisionCard
            key={entry.decision.id}
            sessionId={entry.sessionId}
            title={entry.title}
            decision={entry.decision}
            {...(entry.sessionId === sessionId ? {} : { onOpenSession })}
          />
        ))}
      </Stack>
    </Box>
  );
}
