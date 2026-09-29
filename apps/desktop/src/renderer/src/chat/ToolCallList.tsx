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
import {
  diffTotals,
  groupToolCalls,
  summarizeInput,
  toolRowLabel,
  type DiffTotals,
  type ToolCallGroup,
} from './toolRows';

/** Tools that spend credits on the server rather than doing something to this machine. */
function isGeneration(name: string): boolean {
  return name.startsWith('generate_');
}

/** The question each app-control tool asks, named for what it does rather than "allow this". */
const HOST_QUESTION: Record<string, string> = {
  session_spawn: 'Start this session working? It runs on its own and costs credits.',
  session_send: 'Send this to that conversation? It runs there on its own and costs credits.',
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
  // The diff names the file in its own header, so repeating the path above it is the same
  // string twice in three lines - and a write has no other argument worth a line of its own.
  const argument = call.diff ? '' : summarizeInput(call);

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

      {/* `diff`, never `approvalDiff`: this row is a record of a turn that has happened, and
          only the first of those is one. See ChatToolCall.diff. */}
      {call.diff && (
        <Box sx={{ mt: 0.5 }}>
          <DiffView diff={call.diff} />
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
 * The `+N -M` beside a row's label.
 *
 * Its own element rather than part of the label, and not allowed to shrink: the label is what
 * ellipsizes when the row runs out of width, and these two numbers are the part of it a reader
 * scanning a turn is actually counting on.
 */
function DiffStat({ totals }: { totals: DiffTotals }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ flex: '0 0 auto' }} data-testid="chat-tool-row-diffstat">
      <Typography level="body-xs" textColor="success.plainColor">
        +{totals.added}
      </Typography>
      <Typography level="body-xs" textColor="danger.plainColor">
        -{totals.removed}
      </Typography>
    </Stack>
  );
}

/**
 * One call inside an expanded group of several.
 *
 * It gets its own label because the group's label is a tally: "Ran 7 commands, edited
 * ChatService.ts" is the right thing to read at rest and the wrong thing to navigate by, and a
 * reader who opened the row did so to find which of the seven is the one they want.
 */
function ToolCallEntry({ call, first }: { call: ChatToolCall; first: boolean }) {
  const [open, setOpen] = useState(false);
  const totals = diffTotals([call]);

  return (
    <Box
      component="details"
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
      sx={{ borderTop: first ? undefined : '1px solid', borderColor: 'divider' }}
      data-testid="chat-tool-entry"
      data-status={call.status}
    >
      <Stack
        component="summary"
        direction="row"
        spacing={0.75}
        alignItems="center"
        sx={{
          cursor: 'pointer',
          listStyle: 'none',
          px: 1,
          py: 0.5,
          color: ROW_TONE[call.status],
          '&::-webkit-details-marker': { display: 'none' },
          '&:hover': { opacity: 0.85 },
        }}
        data-testid="chat-tool-entry-summary"
      >
        <Typography level="body-xs" textColor="inherit" noWrap sx={{ minWidth: 0, flex: 1 }}>
          {toolRowLabel(call)}
        </Typography>
        {totals && <DiffStat totals={totals} />}
        <Box sx={{ display: 'flex', opacity: 0.6 }}>
          <ChevronIcon open={open} />
        </Box>
      </Stack>

      <Box sx={{ px: 1, pb: 0.75 }}>
        <ToolCallDetail call={call} />
      </Box>
    </Box>
  );
}

/**
 * One collapsed line of the transcript, and everything behind it.
 *
 * Muted and unboxed on purpose: the assistant's prose is the thing being read, and a panel per
 * tool call turns a turn that touched six files into a wall the reply is buried in.
 *
 * The rule down the left is what makes "this is not the reply" land at a glance. Colour alone
 * did not: a page of body-xs in text.tertiary still reads as more paragraphs when there are
 * twenty of them, and the reader is scanning for where the answer resumes. An indented aside
 * with a rule is the shape of a transcript, and the eye skips it without having to read it.
 */
function ToolGroupRow({ group }: { group: ToolCallGroup }) {
  const [open, setOpen] = useState(false);
  const running = group.status === 'running';
  const single = group.calls.length === 1;

  return (
    <Box sx={{ borderLeft: '2px solid', borderColor: 'divider', pl: 1.25 }}>
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
          <Typography
            level="body-xs"
            textColor="inherit"
            noWrap
            sx={{ minWidth: 0, flex: '0 1 auto' }}
            data-testid="chat-tool-row-label"
          >
            {group.label}
          </Typography>
          {group.diffstat && <DiffStat totals={group.diffstat} />}
          <Box sx={{ display: 'flex', opacity: 0.6 }}>
            <ChevronIcon open={open} />
          </Box>
        </Stack>

        {/* One call needs no list around it: the summary above already named it, and a second
            copy of that label under a second chevron is the same sentence twice.

            No rule of its own either way: the group already sits behind one, and nesting a
            second turns an expanded row into a ladder. */}
        {single ? (
          <Box sx={{ pt: 0.5, pb: 0.5 }}>
            <ToolCallDetail call={group.calls[0]} />
          </Box>
        ) : (
          <Sheet
            variant="outlined"
            sx={{ borderRadius: 'sm', my: 0.5, bgcolor: 'transparent' }}
            data-testid="chat-tool-entries"
          >
            {group.calls.map((call, index) => (
              <ToolCallEntry key={call.id} call={call} first={index === 0} />
            ))}
          </Sheet>
        )}
      </Box>

      {/* Outside the <details>, both of them: a generated image nobody can see until they
          expand a collapsed row is not a rendered image, and "out of credits" is not a detail.
          Still inside the rule, because both belong to the call that produced them. */}
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
