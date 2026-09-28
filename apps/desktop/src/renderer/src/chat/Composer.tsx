import { useState, type KeyboardEvent, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import { contentColumnSx } from './layout';

export function Composer({
  disabled,
  streaming,
  onSend,
  onStop,
  footer,
}: {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Controls that belong to the next turn rather than to the app - the model picker. */
  footer?: ReactNode;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    const prompt = text.trim();
    if (!prompt || disabled || streaming) return;
    setText('');
    onSend(prompt);
  };

  // Enter sends, Shift+Enter breaks the line - the convention every chat client here shares.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ ...contentColumnSx, py: 1.5 }}>
        <Textarea
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'Pick a conversation to start typing' : 'Send a message...'}
          disabled={disabled}
          minRows={1}
          maxRows={8}
          sx={{ flex: 1 }}
          slotProps={{ textarea: { 'data-testid': 'chat-composer-input' } }}
        />
        {streaming ? (
          <Button variant="soft" color="neutral" onClick={onStop} data-testid="chat-stop-btn">
            Stop
          </Button>
        ) : (
          <Button onClick={submit} disabled={disabled || !text.trim()} data-testid="chat-send-btn">
            Send
          </Button>
        )}
      </Stack>

      {footer && (
        <Stack direction="row" alignItems="center" sx={{ ...contentColumnSx, pb: 1, mt: -0.5 }}>
          {footer}
        </Stack>
      )}
    </Box>
  );
}
