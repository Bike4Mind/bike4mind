import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { PendingDecision, PendingTaskDecision, TaskDecisionAnswer } from '@shared/orchestration';
import { contentColumnSx } from './layout';
import { QuestionCard } from './QuestionCard';
import { SessionLink } from './SessionLink';

/** Every decision workers wait on the user for: read once, then replaced by each push of the whole list. */
export function useTaskDecisions(): PendingTaskDecision[] {
  const [decisions, setDecisions] = useState<PendingTaskDecision[]>([]);
  useEffect(() => {
    let pushed = false;
    let unmounted = false;
    const off = window.b4m.chat.onTaskDecisions(list => {
      pushed = true;
      setDecisions(list);
    });
    window.b4m.chat
      .listTaskDecisions()
      .then(list => {
        // A push that landed first is newer than this read.
        if (!pushed && !unmounted) setDecisions(list);
      })
      .catch(() => undefined);
    return () => {
      unmounted = true;
      off();
    };
  }, []);
  return decisions;
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
}: {
  sessionId: string;
  title: string;
  decision: PendingDecision;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (value: TaskDecisionAnswer) => {
    setSending(true);
    setError(null);
    try {
      await window.b4m.chat.answerTaskDecision(sessionId, decision.id, value);
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
  if (!sessionId) return null;
  const shown = decisions.filter(entry => entry.rootId === sessionId || entry.sessionId === sessionId);
  if (shown.length === 0) return null;
  return (
    <Stack spacing={0.75} sx={{ ...contentColumnSx, pt: 1.5 }} data-testid="task-decision-list">
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
  );
}
