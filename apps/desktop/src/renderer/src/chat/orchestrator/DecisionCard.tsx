import { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { SESSION_EXPIRED_STOP, type SendMessageResult } from '@shared/chat';
import type { ErrorPendingDecision, PendingDecision, StoppedPendingDecision } from '@shared/pendingDecisions';
import { ASK_USER_TOOL_NAME } from '@shared/questions';
import { HeldRelayRow } from '../HeldRelayCard';
import { TaskDecisionCard } from '../TaskDecisionCards';
import { PendingRequests } from './AgentPeekDrawer';

/** Who asked: the name the stage gives the session, and its chain from the root, e.g. ["Quest", "Ada", "Bo"]. */
export interface DecisionAsker {
  name: string;
  path: readonly string[];
}

export interface DecisionCardProps {
  decision: PendingDecision;
  asker: DecisionAsker;
  /** Show the asking session's details; where a card that collects secrets is answered. */
  onOpenDetails(sessionId: string): void;
  /** A resolve went through or found the decision already gone: refetch, and the card goes with it. */
  onSettled?(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * Any decision a descendant is waiting on, answerable where it is drawn: the flat Needs-you strip
 * and, inline, the nested Agent view. Every action is the same renderer-only IPC the session's own
 * conversation uses, and each is first-wins in main, so a second surface clicking is a no-op.
 */
export function DecisionCard({ decision, asker, onOpenDetails, onSettled }: DecisionCardProps) {
  const { sessionId } = decision;
  // An answered approval goes at once, so no empty shell waits on the refetch.
  const [answered, setAnswered] = useState(false);
  if (answered) return null;
  const settleAnswered = () => {
    setAnswered(true);
    onSettled?.();
  };
  return (
    <Stack
      spacing={0.75}
      data-testid="decision-card"
      data-kind={decision.kind}
      data-session-id={sessionId}
      data-decision-id={decision.decisionId}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap data-testid="decision-card-asker">
            {asker.name}
          </Typography>
          {asker.path.length > 1 && (
            <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="decision-card-path">
              {asker.path.join(' > ')}
            </Typography>
          )}
        </Box>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => onOpenDetails(sessionId)}
          data-testid="decision-card-open-btn"
        >
          Details
        </Button>
      </Box>
      <DecisionBody
        decision={decision}
        asker={asker}
        onOpenDetails={onOpenDetails}
        onSettled={onSettled}
        onAnswered={settleAnswered}
      />
    </Stack>
  );
}

export function DecisionBody({
  decision,
  asker,
  onOpenDetails,
  onSettled,
  onAnswered,
}: DecisionCardProps & {
  /** It was answered here: approved or denied for an approval, else answered. */
  onAnswered(outcome: 'approved' | 'denied' | 'answered'): void;
}) {
  const { sessionId } = decision;
  switch (decision.kind) {
    case 'approval':
      if (decision.collectsSecrets) {
        return (
          <Sheet variant="outlined" color="warning" sx={{ borderRadius: 'md', p: 1.25 }}>
            <Stack spacing={0.75}>
              <Typography level="body-sm">
                Wants to set up an MCP server. Its secrets are entered in the agent&apos;s details.
              </Typography>
              <Box>
                <Button
                  size="sm"
                  variant="solid"
                  color="primary"
                  onClick={() => onOpenDetails(sessionId)}
                  data-testid="decision-card-review-btn"
                >
                  Review
                </Button>
              </Box>
            </Stack>
          </Sheet>
        );
      }
      return (
        <PendingRequests
          sessionId={sessionId}
          calls={[decision.call]}
          onAnswered={answer =>
            onAnswered(
              decision.call.name === ASK_USER_TOOL_NAME
                ? 'answered'
                : answer.decision === 'deny'
                  ? 'denied'
                  : 'approved'
            )
          }
        />
      );
    case 'question':
      return (
        <TaskDecisionCard
          sessionId={sessionId}
          title={asker.name}
          decision={decision.decision}
          onAnswered={() => onAnswered('answered')}
        />
      );
    case 'held-relay':
      return (
        <HeldRelayRow
          held={decision.held}
          onResolve={async (heldId, deliver) => {
            await window.b4m.chat.resolveHeldRelay(sessionId, heldId, deliver);
            onAnswered('answered');
          }}
          onOpenSession={onOpenDetails}
        />
      );
    case 'error':
    case 'stopped':
      return <RerunCard decision={decision} onSettled={onSettled} />;
  }
}

/** A failed turn's Retry, or a paused turn's Continue. */
function RerunCard({
  decision,
  onSettled,
}: {
  decision: ErrorPendingDecision | StoppedPendingDecision;
  onSettled?(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = decision.kind === 'error';

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result: SendMessageResult = retry
        ? await window.b4m.chat.regenerateReply(decision.sessionId)
        : await window.b4m.chat.continueReply(decision.sessionId);
      if (result.ok) setStarted(true);
      // `busy`: a turn is already running, most likely this same click from another surface.
      else if (!result.busy) setError(result.error);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
      onSettled?.();
    }
  };

  const label = retry
    ? `The last turn failed: ${decision.error}`
    : decision.stopReason === SESSION_EXPIRED_STOP
      ? 'Paused - sign in again, then continue'
      : 'Paused before finishing its turn';

  return (
    <Sheet variant="outlined" color={retry ? 'danger' : 'warning'} sx={{ borderRadius: 'md', p: 1.25 }}>
      <Stack spacing={0.75}>
        <Typography level="body-sm" data-testid="decision-card-rerun-reason" sx={{ wordBreak: 'break-word' }}>
          {label}
        </Typography>
        {error && (
          <Typography level="body-xs" color="danger" data-testid="decision-card-error">
            {error}
          </Typography>
        )}
        <Box>
          <Button
            size="sm"
            variant="solid"
            color="primary"
            disabled={busy || started}
            onClick={() => void run()}
            data-testid={retry ? 'decision-card-retry-btn' : 'decision-card-continue-btn'}
          >
            {retry ? 'Retry' : 'Continue'}
          </Button>
        </Box>
      </Stack>
    </Sheet>
  );
}
