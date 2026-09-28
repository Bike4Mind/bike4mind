import { useEffect, useRef } from 'react';
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
import { contentColumnSx } from './layout';
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
}: {
  message: ChatMessage;
  onRespond: RespondToApproval;
  /** Absent unless this is the turn a Continue would resume; see MessageThread. */
  onContinue?: () => void;
}) {
  const toolCalls = message.toolCalls ?? [];

  return (
    <Box sx={{ minWidth: 0 }} data-testid="chat-message-assistant">
      {/* pre-wrap, not a markdown renderer: the model emits newlines and indentation that
          collapse to a single line without it. Rendering markdown is its own task. */}
      {message.content.length > 0 && (
        <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.content}
        </Typography>
      )}

      {/* After the text, which is the order it arrives in: the model says what it is about to
          do, then asks for the tool. Above it, an approval prompt appears before its reason. */}
      <ToolCallList calls={toolCalls} onRespond={onRespond} />

      {/* After both, because an artifact is what the turn produced rather than part of how it
          got there. `content` has already had the markup removed, so nothing is shown twice. */}
      <ArtifactList artifacts={message.artifacts ?? []} />

      {message.error && (
        <Alert size="sm" color="danger" variant="soft" sx={{ mt: 1 }} data-testid="chat-message-error">
          {message.error}
        </Alert>
      )}

      <StopReasonRow reason={message.stopReason} onContinue={onContinue} />
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

export function MessageThread({
  messages,
  sessionId,
  streaming,
  onRespond,
  onContinue,
}: {
  messages: ChatMessage[];
  /** Needed to read attachment bytes back; they are stored per conversation. */
  sessionId: string | null;
  /** A reply is in flight for this conversation, so there is nothing to resume yet. */
  streaming: boolean;
  onRespond: RespondToApproval;
  onContinue: () => void;
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
          message.system ? (
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
            />
          )
        )}
        <div ref={bottom} />
      </Stack>
    </Box>
  );
}
