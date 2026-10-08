import { useState, type MouseEvent } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type {
  ChatApprovalAnswer,
  ChatDiff,
  ChatMoveToBackgroundResult,
  ChatToolCall,
  ChatToolNotice,
  ChatToolStatus,
} from '@shared/chat';
import { ASK_USER_TOOL_NAME, parseOutcome, parseQuestions } from '@shared/questions';
import { ApprovalChoiceButtons } from './ApprovalChoice';
import { DiffView } from './DiffView';
import { ChevronIcon } from './icons';
import { MediaAttachments } from './MediaAttachment';
import { QuestionCard, QuestionSummary } from './QuestionCard';
import {
  diffTotals,
  groupToolCalls,
  summarizeInput,
  toolDuration,
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

export type RespondToApproval = (approvalId: string, answer: ChatApprovalAnswer) => void;

/** Promote the foreground command one running tool call is waiting on; see BackgroundTaskPanel. */
export type MoveCallToBackground = (callId: string) => Promise<ChatMoveToBackgroundResult>;

/** The one tool whose call is a command this app is sitting and waiting on. */
function isMovable(call: ChatToolCall): boolean {
  return call.name === 'bash_execute' && call.status === 'running';
}

/**
 * The way out of waiting for a command that is taking longer than anyone meant it to.
 *
 * Only on a running row, because that is the only moment the choice exists: once the command
 * has settled there is nothing left to move, and the row says so by losing the control.
 *
 * A refusal is shown rather than swallowed. The background process cap is the one that will
 * actually be hit, and "nothing happened" next to a command still spinning would read as a
 * broken button rather than as a full queue.
 */
function MoveToBackgroundButton({ call, onMove }: { call: ChatToolCall; onMove: MoveCallToBackground }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const move = (event: MouseEvent) => {
    // The control sits inside a <summary>, where a plain click would also toggle the row open.
    event.preventDefault();
    event.stopPropagation();
    setBusy(true);
    setRefusal(null);
    void onMove(call.id)
      .then(result => {
        if (!result.ok) setRefusal(result.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        disabled={busy}
        onClick={move}
        sx={{ flex: '0 0 auto', minHeight: 0, px: 0.75, py: 0, fontSize: 'sm', fontWeight: 'md' }}
        data-testid="component-action-element"
      >
        Move to background
      </Button>
      {refusal && (
        <Typography level="body-sm" textColor="warning.plainColor" noWrap sx={{ flex: '0 1 auto' }}>
          {refusal}
        </Typography>
      )}
    </>
  );
}

/** Named for what it does to the file, so nothing reads as a generic "allow this". */
const APPROVAL_QUESTION: Record<ChatDiff['operation'], string> = {
  create: 'Create this file?',
  overwrite: 'Replace this file?',
  edit: 'Apply this edit?',
  delete: 'Delete this file?',
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
 * What an "always allow" on this card would grant, as text beside the buttons rather than on one.
 *
 * It used to BE that button's label, which is how a consent surface ended up with its broadest
 * and least reversible choice as the biggest thing in the box: the label grew with every pattern
 * and directory the command touched, and wrapped to two lines. The action belongs on the button
 * and the scope belongs here, where it can wrap without pushing the other choices around.
 *
 * `title` carries the list uncapped and with full paths, because an abbreviated path must not be
 * the only account of what is being granted.
 */
function AlwaysScopeLine({ call }: { call: ChatToolCall }) {
  return (
    <Typography
      level="body-xs"
      textColor="text.tertiary"
      title={call.approvalAlwaysFull ?? call.approvalAlways}
      sx={{ mt: 0.75, overflowWrap: 'anywhere' }}
      data-testid="chat-tool-approval-scope"
    >
      {call.approvalAlways
        ? `"Always allow" covers ${call.approvalAlways} for the rest of this conversation.`
        : '"Always allow" applies for the rest of this conversation.'}
    </Typography>
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
  const diffs = call.approvalDiffs ?? (call.approvalDiff ? [call.approvalDiff] : []);
  const diff = diffs[0];
  // No undo behind it, so the card is red and offers no way to stop being asked. Answering
  // "always" would be a single click standing in for consent to a later, different deletion.
  const irreversible = call.approvalIrreversible === true;
  const choice = call.approvalChoice;

  return (
    <Sheet
      variant="soft"
      color={irreversible ? 'danger' : 'primary'}
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25, my: 0.5 }}
      data-testid="chat-tool-approval"
      data-irreversible={irreversible ? 'true' : undefined}
    >
      <Typography level="body-sm" fontWeight="lg">
        {diff
          ? diffs.length > 1
            ? `Apply this patch to ${diffs.length} files?`
            : APPROVAL_QUESTION[diff.operation]
          : (HOST_QUESTION[call.name] ??
            (isGeneration(call.name)
              ? 'Generate this? It costs credits.'
              : call.name === 'bash_background'
                ? 'Start this in the background?'
                : 'Run this command?'))}
      </Typography>

      {diff ? (
        <Stack spacing={0.75} sx={{ mt: 0.75 }}>
          {diffs.map(each => (
            <DiffView key={each.path} diff={each} />
          ))}
        </Stack>
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
            level="body-sm"
            fontFamily="monospace"
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'normal', overflowWrap: 'anywhere' }}
            data-testid="chat-tool-approval-detail"
          >
            {call.approvalDetail ?? summarizeInput(call)}
          </Typography>
        </Box>
      )}

      {choice ? (
        <ApprovalChoiceButtons
          choice={choice}
          onAnswer={answer => onRespond(approvalId, answer)}
          onDeny={() => onRespond(approvalId, { decision: 'deny' })}
          denyLabel="Don't start it"
          alwaysLabel="Always answer this way in this chat"
          testPrefix="chat-tool-approval"
        />
      ) : (
        <>
          <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              size="sm"
              color={irreversible ? 'danger' : 'primary'}
              onClick={() => onRespond(approvalId, { decision: 'once' })}
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
                color="neutral"
                onClick={() => onRespond(approvalId, { decision: 'always' })}
                data-testid="chat-tool-approve-always"
              >
                Always allow
              </Button>
            )}
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => onRespond(approvalId, { decision: 'deny' })}
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
          {!irreversible && <AlwaysScopeLine call={call} />}
        </>
      )}
    </Sheet>
  );
}

/** One call's full detail, behind the disclosure: what it was given, and what it returned. */
function ToolCallDetail({ call }: { call: ChatToolCall }) {
  // The diff names the file in its own header, so repeating the path above it is the same
  // string twice in three lines - and a write has no other argument worth a line of its own.
  const diffs = call.diffs ?? (call.diff ? [call.diff] : []);
  const argument = diffs.length > 0 ? '' : summarizeInput(call);

  const asked = call.name === ASK_USER_TOOL_NAME ? parseQuestions(call.input.questions) : null;
  if (asked && 'questions' in asked && call.status === 'done') {
    const outcome = parseOutcome(call.input.outcome);
    return (
      <Box data-testid="chat-tool-detail">
        <QuestionSummary
          questions={asked.questions}
          answers={outcome?.status === 'answered' ? outcome.answers : undefined}
          note={
            outcome?.status === 'skipped'
              ? 'Skipped'
              : outcome?.status === 'cancelled'
                ? 'Cancelled before it was answered'
                : undefined
          }
        />
      </Box>
    );
  }

  return (
    <Box data-testid="chat-tool-detail">
      {argument && (
        <Typography
          level="body-sm"
          fontFamily="monospace"
          textColor="text.tertiary"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          data-testid="chat-tool-detail-input"
        >
          {argument}
        </Typography>
      )}

      {/* `diff`, never `approvalDiff`: this row is a record of a turn that has happened, and
          only the first of those is one. See ChatToolCall.diff. */}
      {diffs.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 0.5 }}>
          {diffs.map(each => (
            <DiffView key={each.path} diff={each} />
          ))}
        </Stack>
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
  moved: 'text.tertiary',
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
      <Typography level="body-sm" textColor="success.plainColor">
        +{totals.added}
      </Typography>
      <Typography level="body-sm" textColor="danger.plainColor">
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
function ToolCallEntry({ call, first, onMove }: { call: ChatToolCall; first: boolean; onMove?: MoveCallToBackground }) {
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
        title={toolDuration(call)}
      >
        <Typography level="body-sm" textColor="inherit" noWrap sx={{ minWidth: 0, flex: 1 }}>
          {toolRowLabel(call)}
        </Typography>
        {totals && <DiffStat totals={totals} />}
        {onMove && isMovable(call) && <MoveToBackgroundButton call={call} onMove={onMove} />}
        <Box sx={{ display: 'flex', opacity: 0.6 }}>
          <ChevronIcon open={open} />
        </Box>
      </Stack>

      {open && (
        <Box sx={{ px: 1, pb: 0.75 }}>
          <ToolCallDetail call={call} />
        </Box>
      )}
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
 * did not: a page of muted rows still reads as more paragraphs when there are twenty of them,
 * and the reader is scanning for where the answer resumes. An indented aside with a rule is the
 * shape of a transcript, and the eye skips it without having to read it.
 *
 * Which is why the rows are set at the reply's own body-sm rather than under it: the rule and
 * the colour are carrying the separation, so a size too small to read comfortably was buying
 * nothing. The result block behind the disclosure is the one thing held back at body-xs - it is
 * the only part of a row that runs to hundreds of lines, and so the only part that can actually
 * build the wall the paragraph above is about.
 */
function ToolGroupRow({ group, onMove }: { group: ToolCallGroup; onMove?: MoveCallToBackground }) {
  const [open, setOpen] = useState(false);
  const running = group.status === 'running';
  const single = group.calls.length === 1;
  // On the summary only when there is no ambiguity about which command it would move; a group
  // running several at once lists them, and each entry carries its own control instead.
  const movable = group.calls.filter(isMovable);

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
            level="body-sm"
            textColor="inherit"
            noWrap
            sx={{ minWidth: 0, flex: '0 1 auto' }}
            data-testid="chat-tool-row-label"
          >
            {group.label}
          </Typography>
          {group.diffstat && <DiffStat totals={group.diffstat} />}
          {onMove && movable.length === 1 && <MoveToBackgroundButton call={movable[0]} onMove={onMove} />}
          <Box sx={{ display: 'flex', opacity: 0.6 }}>
            <ChevronIcon open={open} />
          </Box>
        </Stack>

        {/* Mounted only while open. A closed row is a single line, and drawing its output,
            diffs and highlighting anyway is what made a long transcript slow to open - a
            reply with a hundred tool calls paid for a hundred hidden results.

            One call needs no list around it: the summary above already named it, and a second
            copy of that label under a second chevron is the same sentence twice.

            No rule of its own either way: the group already sits behind one, and nesting a
            second turns an expanded row into a ladder. */}
        {!open ? null : single ? (
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
              <ToolCallEntry
                key={call.id}
                call={call}
                first={index === 0}
                {...(movable.length > 1 ? { onMove } : {})}
              />
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

export function ToolCallList({
  calls,
  onRespond,
  onMove,
}: {
  calls: ChatToolCall[];
  onRespond: RespondToApproval;
  /** Absent where there is no conversation to move a command in; the control is then not drawn. */
  onMove?: MoveCallToBackground;
}) {
  if (calls.length === 0) return null;

  return (
    <Stack sx={{ my: 1 }}>
      {groupToolCalls(calls).map(group => {
        const waiting = group.calls[0];
        const questions = waiting.name === ASK_USER_TOOL_NAME ? parseQuestions(waiting.input.questions) : null;
        if (questions && 'questions' in questions && waiting.approvalId) {
          const approvalId = waiting.approvalId;
          return (
            <QuestionCard
              key={group.id}
              questions={questions.questions}
              onSubmit={answers => onRespond(approvalId, { decision: 'once', answers })}
              onSkip={() => onRespond(approvalId, { decision: 'deny' })}
            />
          );
        }
        return group.status === 'awaiting-approval' && waiting.approvalId ? (
          <ApprovalPrompt key={group.id} call={waiting} approvalId={waiting.approvalId} onRespond={onRespond} />
        ) : (
          <ToolGroupRow key={group.id} group={group} {...(onMove ? { onMove } : {})} />
        );
      })}
    </Stack>
  );
}
