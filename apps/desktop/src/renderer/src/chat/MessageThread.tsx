import { useEffect, useRef } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatMessage } from '@shared/chat';
import { contentColumnSx } from './layout';
import { ToolCallList, type RespondToApproval } from './ToolCallList';

function StopReasonChip({ reason }: { reason?: string }) {
  if (reason === 'max_tokens') {
    return (
      <Chip size="sm" color="warning" variant="soft" sx={{ mt: 1 }} data-testid="chat-truncated-chip">
        Cut off at the length limit
      </Chip>
    );
  }
  if (reason === 'tool_turn_limit') {
    return (
      <Chip size="sm" color="warning" variant="soft" sx={{ mt: 1 }} data-testid="chat-tool-limit-chip">
        Stopped after too many tool calls
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
function UserTurn({ message }: { message: ChatMessage }) {
  return (
    <Stack direction="row" justifyContent="flex-end">
      <Sheet
        variant="soft"
        color="primary"
        sx={{ px: 2, py: 1.25, borderRadius: 'lg', maxWidth: '85%', minWidth: 0 }}
        data-testid="chat-message-user"
      >
        <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.content}
        </Typography>
      </Sheet>
    </Stack>
  );
}

/**
 * The assistant's turn: set flush in the column with no bubble around it.
 *
 * A reply can run for screens, and a container drawn around that much text reads as a wall
 * rather than as prose; the right-aligned user bubble is what separates the two speakers.
 */
function AssistantTurn({
  message,
  streaming,
  onRespond,
}: {
  message: ChatMessage;
  streaming: boolean;
  onRespond: RespondToApproval;
}) {
  const toolCalls = message.toolCalls ?? [];
  const awaitingFirstToken = streaming && message.content.length === 0 && toolCalls.length === 0 && !message.error;

  return (
    <Box sx={{ minWidth: 0 }} data-testid="chat-message-assistant">
      {awaitingFirstToken ? (
        <CircularProgress size="sm" data-testid="chat-awaiting-reply" />
      ) : (
        // pre-wrap, not a markdown renderer: the model emits newlines and indentation that
        // collapse to a single line without it. Rendering markdown is its own task.
        message.content.length > 0 && (
          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {message.content}
          </Typography>
        )
      )}

      {/* After the text, which is the order it arrives in: the model says what it is about to
          do, then asks for the tool. Above it, an approval prompt appears before its reason. */}
      <ToolCallList calls={toolCalls} onRespond={onRespond} />

      {message.error && (
        <Alert size="sm" color="danger" variant="soft" sx={{ mt: 1 }} data-testid="chat-message-error">
          {message.error}
        </Alert>
      )}

      <StopReasonChip reason={message.stopReason} />
    </Box>
  );
}

export function MessageThread({
  messages,
  streaming,
  onRespond,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  onRespond: RespondToApproval;
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
          message.role === 'user' ? (
            <UserTurn key={message.id} message={message} />
          ) : (
            <AssistantTurn
              key={message.id}
              message={message}
              streaming={streaming && index === messages.length - 1}
              onRespond={onRespond}
            />
          )
        )}
        <div ref={bottom} />
      </Stack>
    </Box>
  );
}
