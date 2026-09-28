import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatApprovalDecision, ChatToolCall, ChatToolNotice, ChatToolStatus } from '@shared/chat';
import { DiffView } from './DiffView';
import { MediaAttachments } from './MediaAttachment';

/** Tools that spend credits on the server rather than doing something to this machine. */
function isGeneration(name: string): boolean {
  return name.startsWith('generate_');
}

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

/** Named for what it does to the file, so nothing reads as a generic "allow this". */
const APPROVAL_QUESTION: Record<'create' | 'overwrite' | 'edit', string> = {
  create: 'Create this file?',
  overwrite: 'Replace this file?',
  edit: 'Apply this edit?',
};

/** The argument worth showing next to the tool name - almost always what it acted on. */
function summarizeInput(call: ChatToolCall): string {
  const input = call.input ?? {};
  const interesting = input.path ?? input.pattern ?? input.command ?? input.prompt ?? input.text ?? input.id;
  return typeof interesting === 'string' ? interesting : '';
}

/**
 * A cost or provider outcome, on its own rather than inside the collapsed tool body.
 *
 * Running out of credits is a warning and not a failure of this app, and a substituted provider
 * is not a failure at all - both would read wrong as red monospace error text, and both are
 * things the user has to see without clicking anything.
 */
function NoticeBanner({ notice }: { notice: ChatToolNotice }) {
  const outOfCredits = notice.kind === 'insufficient-credits';
  return (
    <Sheet
      variant="soft"
      color="warning"
      sx={{ borderRadius: 'sm', px: 1.5, py: 1, mt: 0.5 }}
      data-testid={outOfCredits ? 'chat-tool-credits-notice' : 'chat-tool-provider-notice'}
    >
      <Typography level="body-xs" fontWeight="lg">
        {outOfCredits ? 'Out of credits' : 'A different provider was used'}
      </Typography>
      <Typography level="body-xs" sx={{ mt: 0.25 }}>
        {notice.text}
      </Typography>
    </Sheet>
  );
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
  const diff = call.approvalDiff;

  return (
    <Sheet
      variant="soft"
      color="primary"
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25 }}
      data-testid="chat-tool-approval"
    >
      <Typography level="body-xs" fontWeight="lg">
        {diff
          ? APPROVAL_QUESTION[diff.operation]
          : isGeneration(call.name)
            ? 'Generate this? It costs credits.'
            : call.name === 'bash_background'
              ? 'Start this in the background?'
              : 'Run this command?'}
      </Typography>

      {diff ? (
        <Box sx={{ mt: 0.75 }}>
          <DiffView diff={diff} />
        </Box>
      ) : (
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
      )}

      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="sm" onClick={() => onRespond(approvalId, 'once')} data-testid="chat-tool-approve-once">
          {diff ? 'Apply this change' : isGeneration(call.name) ? 'Generate it' : 'Allow once'}
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
          {diff ? "Don't change it" : isGeneration(call.name) ? "Don't generate" : "Don't run"}
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

  const media = call.media ?? [];

  return (
    <Box>
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
          {/* While running, the progress line takes the slot the argument had: on a generation
              it is the only thing that distinguishes "working" from "wedged", and the prompt is
              already on screen above, in the approval the user just answered. */}
          {call.status === 'running' && call.progress ? (
            <Typography level="body-xs" textColor="text.secondary" noWrap data-testid="chat-tool-progress">
              {call.progress}
            </Typography>
          ) : (
            summary && (
              <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>
                {summary}
              </Typography>
            )
          )}
        </Stack>

        <Box sx={{ pt: 0.75 }}>
          <Typography
            level="body-xs"
            fontFamily="monospace"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto' }}
            textColor={call.error ? 'danger.400' : 'text.secondary'}
          >
            {call.error ?? call.preview ?? call.progress ?? 'Running...'}
          </Typography>
        </Box>
      </Box>

      {/* Outside the <details>, both of them: a generated image nobody can see until they
          expand a collapsed row is not a rendered image, and "out of credits" is not a detail. */}
      {call.notice && <NoticeBanner notice={call.notice} />}
      <MediaAttachments media={media} />
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
