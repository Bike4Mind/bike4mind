import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatApprovalDecision, ChatToolCall, ChatToolStatus } from '@shared/chat';

const STATUS_COLOR: Record<ChatToolStatus, 'neutral' | 'success' | 'danger' | 'warning' | 'primary'> = {
  'awaiting-approval': 'primary',
  running: 'neutral',
  done: 'success',
  error: 'danger',
  denied: 'warning',
};

const STATUS_LABEL: Record<ChatToolStatus, string> = {
  'awaiting-approval': 'needs approval',
  running: 'running',
  done: 'done',
  error: 'error',
  denied: 'denied',
};

export type RespondToApproval = (approvalId: string, decision: ChatApprovalDecision) => void;

/** The argument worth showing next to the tool name - almost always what it acted on. */
function summarizeInput(call: ChatToolCall): string {
  const input = call.input ?? {};
  const interesting = input.path ?? input.pattern ?? input.command ?? input.id;
  return typeof interesting === 'string' ? interesting : '';
}

/**
 * The consent prompt for a tool that has not run yet.
 *
 * Deliberately not a `details` the user can leave collapsed: the command is the whole thing
 * they are being asked about, so it is always on screen next to the buttons that allow it.
 */
function ApprovalPrompt({
  call,
  approvalId,
  onRespond,
}: {
  call: ChatToolCall;
  approvalId: string;
  onRespond: RespondToApproval;
}) {
  return (
    <Sheet
      variant="soft"
      color="primary"
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25 }}
      data-testid="chat-tool-approval"
    >
      <Typography level="body-xs" fontWeight="lg">
        {call.name === 'bash_background' ? 'Start this in the background?' : 'Run this command?'}
      </Typography>

      <Box
        sx={{
          mt: 0.75,
          p: 1,
          borderRadius: 'sm',
          bgcolor: 'background.surface',
          maxHeight: 200,
          overflowY: 'auto',
        }}
      >
        <Typography
          level="body-xs"
          fontFamily="monospace"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          data-testid="chat-tool-approval-detail"
        >
          {call.approvalDetail ?? summarizeInput(call)}
        </Typography>
      </Box>

      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="sm" onClick={() => onRespond(approvalId, 'once')} data-testid="chat-tool-approve-once">
          Allow once
        </Button>
        <Button
          size="sm"
          variant="soft"
          onClick={() => onRespond(approvalId, 'always')}
          data-testid="chat-tool-approve-always"
        >
          Always in this chat
        </Button>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => onRespond(approvalId, 'deny')}
          data-testid="chat-tool-deny"
        >
          Don't run
        </Button>
      </Stack>
    </Sheet>
  );
}

function ToolCall({ call, onRespond }: { call: ChatToolCall; onRespond: RespondToApproval }) {
  const summary = summarizeInput(call);

  if (call.status === 'awaiting-approval' && call.approvalId) {
    return <ApprovalPrompt call={call} approvalId={call.approvalId} onRespond={onRespond} />;
  }

  return (
    <Box
      component="details"
      sx={{ borderRadius: 'sm', bgcolor: 'background.level2', px: 1, py: 0.5 }}
      data-testid="chat-tool-call"
    >
      <Stack component="summary" direction="row" spacing={1} alignItems="center" sx={{ cursor: 'pointer' }}>
        {call.status === 'running' ? (
          <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
        ) : (
          <Chip size="sm" variant="soft" color={STATUS_COLOR[call.status]} data-testid="chat-tool-status">
            {STATUS_LABEL[call.status]}
          </Chip>
        )}
        <Typography level="body-xs" fontFamily="monospace">
          {call.name}
        </Typography>
        {summary && (
          <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>
            {summary}
          </Typography>
        )}
      </Stack>

      <Box sx={{ pt: 0.75 }}>
        <Typography
          level="body-xs"
          fontFamily="monospace"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto' }}
          textColor={call.error ? 'danger.400' : 'text.secondary'}
        >
          {call.error ?? call.preview ?? 'Running...'}
        </Typography>
      </Box>
    </Box>
  );
}

export function ToolCallList({ calls, onRespond }: { calls: ChatToolCall[]; onRespond: RespondToApproval }) {
  if (calls.length === 0) return null;
  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      {calls.map(call => (
        <ToolCall key={call.id} call={call} onRespond={onRespond} />
      ))}
    </Stack>
  );
}
