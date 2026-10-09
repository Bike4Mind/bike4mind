import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { WarningIcon } from './icons';

function KeyHint({ children }: { children: string }) {
  return (
    <Typography component="span" level="body-xs" textColor="inherit" sx={{ opacity: 0.7, ml: 0.75 }}>
      ({children})
    </Typography>
  );
}

/**
 * The card for a `request_directory` call: the turn is parked on it until the user adds the folder
 * or declines. Says "the agent" where Claude's desktop app says "Claude", since the model here
 * may be any of several.
 *
 * Enter adds and Escape declines while the card has focus. The card takes focus only when the
 * composer is empty, as QuestionCard does, and Enter is disarmed once anything printable has been
 * typed at it: someone who started a message without noticing the card must not grant a folder by
 * finishing it.
 */
export function DirectoryRequestCard({
  path,
  reason,
  warning,
  onAdd,
  onDecline,
}: {
  path: string;
  reason: string;
  warning?: string;
  onAdd: () => void;
  onDecline: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const stray = useRef(false);
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    const focused = document.activeElement;
    const typing =
      (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) && focused.value.length > 0;
    if (!typing) card.current?.focus();
  }, []);

  const answer = (add: boolean) => {
    if (answered) return;
    setAnswered(true);
    if (add) onAdd();
    else onDecline();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      answer(false);
      return;
    }
    if (event.key === 'Enter') {
      // A focused button answers through its own click; handling it here too would answer twice.
      if ((event.target as HTMLElement).tagName === 'BUTTON' || stray.current || event.repeat) return;
      event.preventDefault();
      answer(true);
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) stray.current = true;
  };

  return (
    <Sheet
      ref={card}
      tabIndex={-1}
      variant="soft"
      color={warning ? 'warning' : 'primary'}
      onKeyDown={onKeyDown}
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25, my: 0.5, outline: 'none' }}
      data-testid="chat-directory-request"
    >
      <Typography level="body-sm" fontWeight="lg">
        The agent would like to add this folder to the session:
      </Typography>
      <Box sx={{ mt: 0.75, p: 1, borderRadius: 'sm', bgcolor: 'background.surface' }}>
        <Typography
          level="body-sm"
          fontFamily="monospace"
          sx={{ overflowWrap: 'anywhere' }}
          data-testid="chat-directory-request-path"
        >
          {path}
        </Typography>
      </Box>
      {warning && (
        <Typography
          level="body-sm"
          color="warning"
          fontWeight="lg"
          startDecorator={<WarningIcon />}
          sx={{ mt: 0.75 }}
          data-testid="chat-directory-request-warning"
        >
          {warning}
        </Typography>
      )}
      <Typography level="body-sm" sx={{ mt: 0.75 }}>
        The agent will be able to read and change files in this folder for this session.
      </Typography>
      <Typography
        level="body-sm"
        textColor="text.secondary"
        sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        data-testid="chat-directory-request-reason"
      >
        {"The agent's reason: "}
        {reason}
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          disabled={answered}
          onClick={() => answer(false)}
          data-testid="chat-directory-request-decline-btn"
        >
          Not now
          <KeyHint>Esc</KeyHint>
        </Button>
        <Button
          size="sm"
          color={warning ? 'warning' : 'primary'}
          disabled={answered}
          onClick={() => answer(true)}
          data-testid="chat-directory-request-add-btn"
        >
          Add folder
          <KeyHint>Enter</KeyHint>
        </Button>
      </Stack>
    </Sheet>
  );
}
