import { useEffect, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { isTurnBudgetStop, type ChatMessage } from '@shared/chat';
import { ArtifactList } from './ArtifactCard';
import { AttachmentRow } from './Attachments';
import { ChevronIcon } from './icons';
import { contentColumnSx } from './layout';
import { ReplyMarkdown } from './markdown/ReplyMarkdown';
import { relaySummary } from './relayRows';
import { callsIn, roundsOf } from './replyRounds';
import { ToolCallList, type RespondToApproval } from './ToolCallList';

/** What each budget the agent loop enforces is called in the thread. See isTurnBudgetStop. */
const BUDGET_STOP_LABELS: Record<string, string> = {
  tool_turn_limit: 'Paused after a lot of tool calls',
  turn_time_limit: 'Paused after running a long time',
  tool_stall_limit: 'Paused after repeating the same step',
};

/**
 * Why a reply ended, when that was not simply the model finishing.
 *
 * A budget stop is drawn beside Continue rather than on its own, so the row says "here is what
 * happened and here is what to do about it" - the chip alone read as a dead end, which is
 * exactly what it no longer is.
 */
function StopReasonRow({ reason, onContinue }: { reason?: string; onContinue?: () => void }) {
  if (reason === 'max_tokens') {
    return (
      <Chip size="sm" color="warning" variant="soft" sx={{ mt: 1 }} data-testid="chat-truncated-chip">
        Cut off at the length limit
      </Chip>
    );
  }
  if (isTurnBudgetStop(reason)) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
        <Chip size="sm" color="warning" variant="soft" data-testid="chat-tool-limit-chip">
          {BUDGET_STOP_LABELS[reason as string]}
        </Chip>
        {onContinue && (
          <Button size="sm" variant="soft" color="primary" onClick={onContinue} data-testid="chat-continue-reply-btn">
            Continue
          </Button>
        )}
      </Stack>
    );
  }
  // No Continue: the next request would carry the same oversized conversation and fail the same
  // way, and a button that cannot work is worse than no button. Says what to do instead.
  if (reason === 'context_limit') {
    return (
      <Chip size="sm" color="warning" variant="soft" sx={{ mt: 1 }} data-testid="chat-context-limit-chip">
        Stopped - this conversation filled the model's context. Start a new one to carry on.
      </Chip>
    );
  }
  if (reason === 'aborted') {
    return (
      <Chip size="sm" color="neutral" variant="soft" sx={{ mt: 1 }} data-testid="chat-stopped-chip">
        Stopped
      </Chip>
    );
  }
  return null;
}

/**
 * The user's own turn: a right-aligned bubble, narrower than the column so the alignment
 * reads as "mine" at a glance even when the text is long.
 */
function UserTurn({ message, sessionId }: { message: ChatMessage; sessionId: string | null }) {
  const attachments = message.attachments ?? [];

  return (
    <Stack direction="row" justifyContent="flex-end">
      <Sheet
        variant="soft"
        color="primary"
        sx={{ px: 2, py: 1.25, borderRadius: 'lg', maxWidth: '85%', minWidth: 0 }}
        data-testid="chat-message-user"
      >
        {/* Above the text, matching the composer: what was handed over, then what was asked
            about it. Not removable here - the turn has been sent. */}
        {attachments.length > 0 && (
          <Box sx={{ mb: message.content ? 1 : 0 }}>
            <AttachmentRow sessionId={sessionId} attachments={attachments} />
          </Box>
        )}
        {/* Literal, where a reply is markdown: this is what the user typed, and rendering it
            would change it. In a Code session they type paths and identifiers, and
            some_file_name would come back as some<em>file</em>name with the underscores eaten.
            A reply is a model writing markdown on purpose; this is not. */}
        {message.content && (
          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {message.content}
          </Typography>
        )}
      </Sheet>
    </Stack>
  );
}

/**
 * The assistant's turn: set flush in the column with no bubble around it.
 *
 * A reply can run for screens, and a container drawn around that much text reads as a wall
 * rather than as prose; the right-aligned user bubble is what separates the two speakers.
 *
 * Nothing here reports that a reply is on its way. The status line under the transcript does
 * that for the whole turn, and a spinner in the thread as well would be the same fact twice.
 */
function AssistantTurn({
  message,
  onRespond,
  onContinue,
  status,
}: {
  message: ChatMessage;
  onRespond: RespondToApproval;
  /** Absent unless this is the turn a Continue would resume; see MessageThread. */
  onContinue?: () => void;
  /** What this turn is doing, while it is the one in flight; see MessageThread. */
  status?: ReactNode;
}) {
  const toolCalls = message.toolCalls ?? [];
  const rounds = roundsOf(message);

  return (
    <Box sx={{ minWidth: 0 }} data-testid="chat-message-assistant">
      {/* The turn in the order it happened: each round's prose, then the tools that round went
          on to run, then the next round's prose. A reply that touched six files across ten
          rounds is a narrative, and every row piled up after every word is not that narrative. */}
      {rounds.map((round, index) => (
        // The gap lives here rather than as a blank line inside the text, so a round that ran
        // tools and said nothing does not leave an empty paragraph behind.
        <Box key={index} sx={{ mt: index === 0 ? 0 : 1.5 }} data-testid="chat-message-round">
          {/* Per round rather than over the whole reply, which is also what keeps a code fence
              from leaking: a block opened in one round cannot swallow the next round's prose,
              because the next round is a parse of its own. */}
          {round.text.length > 0 && <ReplyMarkdown text={round.text} />}
          <ToolCallList calls={callsIn(round, toolCalls)} onRespond={onRespond} />
        </Box>
      ))}

      {/* After both, because an artifact is what the turn produced rather than part of how it
          got there. `content` has already had the markup removed, so nothing is shown twice. */}
      <ArtifactList artifacts={message.artifacts ?? []} />

      {message.error && (
        <Alert size="sm" color="danger" variant="soft" sx={{ mt: 1 }} data-testid="chat-message-error">
          {message.error}
        </Alert>
      )}

      <StopReasonRow reason={message.stopReason} onContinue={onContinue} />

      {/* Last, under the reply it describes, which is where the eye already is while a turn
          runs. It lived in the composer before and read as a property of the input box rather
          than of the answer being written. */}
      {status && <Box sx={{ mt: 1 }}>{status}</Box>}
    </Box>
  );
}

/**
 * A message the app put in the thread rather than either speaker: a spawned session reporting
 * back to the conversation that started it.
 *
 * Centred and quiet, on neither side of the conversation, because it is neither: drawn as a
 * user bubble it would read as something the user typed, and as an assistant turn as something
 * the model said. Both would be a lie about where the text came from.
 */
function SystemTurn({ message }: { message: ChatMessage }) {
  return (
    <Sheet
      variant="soft"
      color="neutral"
      sx={{ px: 2, py: 1.25, borderRadius: 'md' }}
      data-testid="chat-message-system"
    >
      <Typography level="body-xs" textColor="text.tertiary" sx={{ fontWeight: 'lg', mb: 0.5 }}>
        From a session you started
      </Typography>
      <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {message.content}
      </Typography>
    </Sheet>
  );
}

/**
 * A message another conversation sent here with session_send.
 *
 * Drawn as a collapsed row rather than as a turn, for the reason a tool call is: it is how this
 * conversation got somewhere, not part of what was said in it. The distinction that matters is
 * from a USER message - these words were written by a model in another session, and a bubble on
 * the user's side of the thread would be a straightforward lie about who said them. So it sits
 * behind the same left rule the tool rows use, names the sender in the summary, and keeps the
 * full text one click away.
 */
function RelayTurn({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ borderLeft: '2px solid', borderColor: 'divider', pl: 1.25 }}>
      <Box
        component="details"
        open={open}
        onToggle={event => setOpen(event.currentTarget.open)}
        data-testid="chat-message-relay"
        data-from={message.relay?.fromSessionId}
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
            color: 'text.tertiary',
            '&::-webkit-details-marker': { display: 'none' },
            '&:hover': { color: 'text.secondary' },
          }}
          data-testid="chat-message-relay-summary"
        >
          <Typography level="body-xs" textColor="inherit" noWrap sx={{ minWidth: 0 }}>
            {relaySummary(message)}
          </Typography>
          <Box sx={{ display: 'flex', opacity: 0.6 }}>
            <ChevronIcon open={open} />
          </Box>
        </Stack>

        <Typography
          level="body-sm"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', pt: 0.5, pb: 0.5 }}
          textColor="text.secondary"
          data-testid="chat-message-relay-body"
        >
          {message.content}
        </Typography>
      </Box>
    </Box>
  );
}

export function MessageThread({
  messages,
  sessionId,
  streaming,
  onRespond,
  onContinue,
  status,
}: {
  messages: ChatMessage[];
  /** Needed to read attachment bytes back; they are stored per conversation. */
  sessionId: string | null;
  /**
   * A reply is in flight for this conversation, however this window came to know it - so there
   * is nothing to resume, and the live line belongs at the foot of the last turn.
   */
  streaming: boolean;
  onRespond: RespondToApproval;
  onContinue: () => void;
  /**
   * The live turn line, drawn at the foot of the reply in flight. Null when no turn is running,
   * which is the same condition `streaming` reports - so the two can never say different things.
   */
  status?: ReactNode;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  const lastContent = (last?.content.length ?? 0) + (last?.toolCalls?.length ?? 0);

  // Keyed on the growing last message too, so the view follows tokens as they stream in.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, lastContent]);

  if (messages.length === 0) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 3 }}>
        <Typography level="body-sm" textColor="text.tertiary" data-testid="chat-thread-empty">
          Send a message to start this conversation.
        </Typography>
      </Box>
    );
  }

  return (
    // Scrolling on the outer box, the column on the inner one: reversing the two would put the
    // scrollbar in the middle of the window rather than at the edge of the pane.
    <Box sx={{ flex: 1, overflowY: 'auto' }} data-testid="chat-thread">
      <Stack spacing={3} sx={{ ...contentColumnSx, py: 3 }}>
        {messages.map((message, index) =>
          message.relay ? (
            <RelayTurn key={message.id} message={message} />
          ) : message.system ? (
            <SystemTurn key={message.id} message={message} />
          ) : message.role === 'user' ? (
            <UserTurn key={message.id} message={message} sessionId={sessionId} />
          ) : (
            <AssistantTurn
              key={message.id}
              message={message}
              onRespond={onRespond}
              // Only the last turn, and only while nothing is running: resuming writes back
              // into its own message, so a Continue on an older one would edit history.
              {...(index === messages.length - 1 && !streaming ? { onContinue } : {})}
              {...(index === messages.length - 1 && streaming ? { status } : {})}
            />
          )
        )}
        <div ref={bottom} />
      </Stack>
    </Box>
  );
}
