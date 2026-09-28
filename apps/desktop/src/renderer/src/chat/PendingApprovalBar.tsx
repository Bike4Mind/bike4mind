import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatApprovalDecision, ChatPendingApproval } from '@shared/chat';
import { contentColumnSx } from './layout';

/**
 * Approvals raised by conversations the user is NOT looking at.
 *
 * The approval card inside the transcript is the right place to answer a tool the user is
 * watching, and it is the only place - which is exactly the problem once a session can run on
 * its own. A spawned session parks at the gate in a conversation nobody has open; the sidebar
 * row says it needs them, but a badge is not an answer, and a run blocked behind a prompt they
 * never see is indistinguishable from one that hung.
 *
 * So this sits above the composer wherever they happen to be. It names the conversation, shows
 * the same detail the card would, and answers it in place. Approvals for the OPEN conversation
 * are left out: those already have a card, and two live prompts for one request is worse than
 * one in the wrong place.
 */
export function PendingApprovalBar({
  pending,
  openSessionId,
  onRespond,
  onOpenSession,
}: {
  pending: ChatPendingApproval[];
  /** The conversation on screen, whose approvals the transcript is already showing. */
  openSessionId: string | null;
  onRespond: (approvalId: string, decision: ChatApprovalDecision) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const elsewhere = pending.filter(entry => entry.sessionId !== openSessionId);
  if (elsewhere.length === 0) return null;

  // Oldest first, and only the oldest is answerable here: a stack of full prompts above the
  // composer would bury the conversation the user came to read.
  const [next, ...rest] = elsewhere;

  return (
    <Sheet
      variant="soft"
      color="warning"
      sx={{ ...contentColumnSx, borderRadius: 'sm', px: 1.5, py: 1.25, my: 0.5 }}
      data-testid="chat-pending-approval-bar"
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
        <Typography level="body-xs" fontWeight="lg" sx={{ flex: 1, minWidth: 0 }}>
          Another conversation needs you
        </Typography>
        {rest.length > 0 && (
          <Typography level="body-xs" data-testid="chat-pending-approval-more">
            {rest.length} more waiting
          </Typography>
        )}
      </Stack>

      <Typography
        level="body-xs"
        noWrap
        sx={{ mt: 0.25, cursor: 'pointer', textDecoration: 'underline' }}
        onClick={() => onOpenSession(next.sessionId)}
        data-testid="chat-pending-approval-session"
      >
        {next.sessionTitle}
      </Typography>

      <Box
        sx={{
          mt: 0.75,
          p: 1,
          borderRadius: 'sm',
          bgcolor: 'background.surface',
          maxHeight: 160,
          overflowY: 'auto',
        }}
      >
        <Typography
          level="body-xs"
          fontFamily="monospace"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          data-testid="chat-pending-approval-detail"
        >
          {next.detail}
        </Typography>
      </Box>

      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="sm" onClick={() => onRespond(next.approvalId, 'once')} data-testid="chat-pending-approve-once">
          Allow once
        </Button>
        {/* Withheld on an irreversible tool for the same reason the card withholds it: one
            click must never stand in for an answer to a later, different request. */}
        {!next.irreversible && (
          <Button
            size="sm"
            variant="soft"
            onClick={() => onRespond(next.approvalId, 'always')}
            data-testid="chat-pending-approve-always"
          >
            Always in that chat
          </Button>
        )}
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => onRespond(next.approvalId, 'deny')}
          data-testid="chat-pending-deny"
        >
          Don&apos;t allow
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => onOpenSession(next.sessionId)}
          data-testid="chat-pending-open-session-btn"
        >
          Open it
        </Button>
      </Stack>
    </Sheet>
  );
}
