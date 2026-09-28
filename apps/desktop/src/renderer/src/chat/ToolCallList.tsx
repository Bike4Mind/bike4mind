import { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatApprovalDecision, ChatToolCall, ChatToolNotice, ChatToolStatus } from '@shared/chat';
import { DiffView } from './DiffView';
import { ChevronIcon } from './icons';
import { MediaAttachments } from './MediaAttachment';
import { groupToolCalls, summarizeInput, type ToolCallGroup } from './toolRows';

/** Tools that spend credits on the server rather than doing something to this machine. */
function isGeneration(name: string): boolean {
  return name.startsWith('generate_');
}

/** The question each app-control tool asks, named for what it does rather than "allow this". */
const HOST_QUESTION: Record<string, string> = {
  session_spawn: 'Start this session working? It runs on its own and costs credits.',
  session_archive: 'Archive this conversation?',
  session_delete: 'Delete this conversation for good?',
};

export type RespondToApproval = (approvalId: string, decision: ChatApprovalDecision) => void;

/** Named for what it does to the file, so nothing reads as a generic "allow this". */
const APPROVAL_QUESTION: Record<'create' | 'overwrite' | 'edit', string> = {
  create: 'Create this file?',
  overwrite: 'Replace this file?',
  edit: 'Apply this edit?',
};

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
 * they are being asked about, so it is always on screen next to the buttons that allow it. It
 * is the one thing in the transcript that is NOT a quiet grey line - a row nobody notices is a
 * turn that sits blocked until they wonder why.
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
  // No undo behind it, so the card is red and offers no way to stop being asked. Answering
  // "always" would be a single click standing in for consent to a later, different deletion.
  const irreversible = call.approvalIrreversible === true;

  return (
    <Sheet
      variant="soft"
      color={irreversible ? 'danger' : 'primary'}
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25, my: 0.5 }}
      data-testid="chat-tool-approval"
      data-irreversible={irreversible ? 'true' : undefined}
    >
      <Typography level="body-xs" fontWeight="lg">
        {diff
          ? APPROVAL_QUESTION[diff.operation]
          : (HOST_QUESTION[call.name] ??
            (isGeneration(call.name)
              ? 'Generate this? It costs credits.'
              : call.name === 'bash_background'
                ? 'Start this in the background?'
                : 'Run this command?'))}
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
        <Button
          size="sm"
          color={irreversible ? 'danger' : 'primary'}
          onClick={() => onRespond(approvalId, 'once')}
          data-testid="chat-tool-approve-once"
        >
          {irreversible
            ? 'Delete it'
            : diff
              ? 'Apply this change'
              : isGeneration(call.name)
                ? 'Generate it'
                : 'Allow once'}
        </Button>
        {!irreversible && (
          <Button
            size="sm"
            variant="soft"
            onClick={() => onRespond(approvalId, 'always')}
            data-testid="chat-tool-approve-always"
          >
            Always in this chat
          </Button>
        )}
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => onRespond(approvalId, 'deny')}
          data-testid="chat-tool-deny"
        >
          {irreversible
            ? 'Keep it'
            : diff
              ? "Don't change it"
              : isGeneration(call.name)
                ? "Don't generate"
                : "Don't run"}
        </Button>
      </Stack>
    </Sheet>
  );
}

/** One call's full detail, behind the disclosure: what it was given, and what it returned. */
function ToolCallDetail({ call }: { call: ChatToolCall }) {
  const argument = summarizeInput(call);

  return (
    <Box data-testid="chat-tool-detail">
      {argument && (
        <Typography
          level="body-xs"
          fontFamily="monospace"
          textColor="text.secondary"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          data-testid="chat-tool-detail-input"
        >
          {argument}
        </Typography>
      )}

      {/* Only a write tool carries one, and only because it was approved: this is the change the
          user allowed, kept where they can go back and check what it actually was. */}
      {call.approvalDiff && (
        <Box sx={{ mt: 0.5 }}>
          <DiffView diff={call.approvalDiff} />
        </Box>
      )}

      <Typography
        level="body-xs"
        fontFamily="monospace"
        sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto', mt: 0.5 }}
        textColor={call.error ? 'danger.400' : 'text.tertiary'}
        data-testid={call.error ? 'chat-tool-detail-error' : 'chat-tool-detail-result'}
      >
        {call.error ?? call.preview ?? call.progress ?? 'Running...'}
      </Typography>
    </Box>
  );
}

/** The row's colour. Only a failure and a refusal leave the muted grey the prose is set against. */
const ROW_TONE: Record<ChatToolStatus, string> = {
  'awaiting-approval': 'primary.plainColor',
  running: 'text.tertiary',
  done: 'text.tertiary',
  error: 'danger.plainColor',
  denied: 'warning.plainColor',
};

/**
 * One collapsed line of the transcript, and everything behind it.
 *
 * Muted and unboxed on purpose: the assistant's prose is the thing being read, and a panel per
 * tool call turns a turn that touched six files into a wall the reply is buried in.
 */
function ToolGroupRow({ group }: { group: ToolCallGroup }) {
  const [open, setOpen] = useState(false);
  const running = group.status === 'running';

  return (
    <Box>
      <Box
        component="details"
        open={open}
        onToggle={event => setOpen(event.currentTarget.open)}
        data-testid="chat-tool-row"
        data-status={group.status}
      >
        <Stack
          component="summary"
          direction="row"
          spacing={0.75}
          alignItems="center"
          sx={{
            cursor: 'pointer',
            listStyle: 'none',
            py: 0.25,
            color: ROW_TONE[group.status],
            '&::-webkit-details-marker': { display: 'none' },
            '&:hover': { color: group.status === 'done' || running ? 'text.secondary' : undefined, opacity: 0.85 },
          }}
          data-testid="chat-tool-row-summary"
        >
          {running && (
            <CircularProgress
              size="sm"
              sx={{
                '--CircularProgress-size': '11px',
                '--CircularProgress-trackThickness': '2px',
                '--CircularProgress-progressThickness': '2px',
              }}
            />
          )}
          <Typography level="body-xs" textColor="inherit" noWrap sx={{ minWidth: 0 }} data-testid="chat-tool-row-label">
            {group.label}
          </Typography>
          <Box sx={{ display: 'flex', opacity: 0.6 }}>
            <ChevronIcon open={open} />
          </Box>
        </Stack>

        <Stack spacing={1} sx={{ ml: 0.5, pl: 1.5, pt: 0.5, pb: 0.5, borderLeft: '2px solid', borderColor: 'divider' }}>
          {group.calls.map(call => (
            <ToolCallDetail key={call.id} call={call} />
          ))}
        </Stack>
      </Box>

      {/* Outside the <details>, both of them: a generated image nobody can see until they
          expand a collapsed row is not a rendered image, and "out of credits" is not a detail. */}
      {group.calls.map(call => (
        <Box key={call.id}>
          {call.notice && <NoticeBanner notice={call.notice} />}
          <MediaAttachments media={call.media ?? []} />
        </Box>
      ))}
    </Box>
  );
}

export function ToolCallList({ calls, onRespond }: { calls: ChatToolCall[]; onRespond: RespondToApproval }) {
  if (calls.length === 0) return null;

  return (
    <Stack sx={{ my: 1 }}>
      {groupToolCalls(calls).map(group => {
        const waiting = group.calls[0];
        return group.status === 'awaiting-approval' && waiting.approvalId ? (
          <ApprovalPrompt key={group.id} call={waiting} approvalId={waiting.approvalId} onRespond={onRespond} />
        ) : (
          <ToolGroupRow key={group.id} group={group} />
        );
      })}
    </Stack>
  );
}
