import { useEffect, useRef } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatMessage } from '@shared/chat';

function Bubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const isUser = message.role === 'user';
  const awaitingFirstToken = streaming && !isUser && message.content.length === 0 && !message.error;

  return (
    <Stack direction="row" justifyContent={isUser ? 'flex-end' : 'flex-start'}>
      <Sheet
        variant={isUser ? 'solid' : 'soft'}
        color={isUser ? 'primary' : 'neutral'}
        sx={{ px: 1.75, py: 1.25, borderRadius: 'md', maxWidth: '78%', minWidth: 0 }}
        data-testid={isUser ? 'chat-message-user' : 'chat-message-assistant'}
      >
        {awaitingFirstToken ? (
          <CircularProgress size="sm" data-testid="chat-awaiting-reply" />
        ) : (
          // pre-wrap, not a markdown renderer: the model emits newlines and indentation that
          // collapse to a single line without it. Rendering markdown is its own task.
          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {message.content}
          </Typography>
        )}

        {message.error && (
          <Alert size="sm" color="danger" variant="soft" sx={{ mt: 1 }} data-testid="chat-message-error">
            {message.error}
          </Alert>
        )}

        {message.stopReason === 'max_tokens' && (
          <Chip size="sm" color="warning" variant="soft" sx={{ mt: 1 }} data-testid="chat-truncated-chip">
            Cut off at the length limit
          </Chip>
        )}
        {message.stopReason === 'aborted' && (
          <Chip size="sm" color="neutral" variant="soft" sx={{ mt: 1 }} data-testid="chat-stopped-chip">
            Stopped
          </Chip>
        )}
      </Sheet>
    </Stack>
  );
}

export function MessageThread({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const bottom = useRef<HTMLDivElement>(null);
  const lastContent = messages[messages.length - 1]?.content.length ?? 0;

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
    <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }} data-testid="chat-thread">
      <Stack spacing={1.5}>
        {messages.map((message, index) => (
          <Bubble key={message.id} message={message} streaming={streaming && index === messages.length - 1} />
        ))}
        <div ref={bottom} />
      </Stack>
    </Box>
  );
}
