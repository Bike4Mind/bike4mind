import { useState, type KeyboardEvent } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import type { RewindWarning } from '@shared/threadRewind';
import { COPY_BUTTON_CLASS } from './CopyMessageButton';
import { PenIcon, ReloadIcon } from './icons';

/** What an edit or a regenerate says it will cost; see editWarnings and turnsChangedThings. */
export const REWIND_WARNING_TEXT: Record<Exclude<RewindWarning, 'none'>, string> = {
  later: 'Later replies will be removed.',
  changes: 'Later replies will be removed. Changes they made to files are not undone.',
};
export const REGENERATE_WARNING_TEXT = 'This reply will be replaced. Changes it made to files are not undone.';

const ICON_BUTTON_SX = { '--IconButton-size': '1.5rem' } as const;

/**
 * Edit on a sent prompt, beside its Copy and revealed by the same hover rule. Disabled rather
 * than hidden while a turn runs, so the row does not shift when the reply ends.
 */
export function EditMessageButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  const label = disabled ? 'Edit is available when the reply finishes' : 'Edit and resend';
  return (
    <IconButton
      size="sm"
      variant="plain"
      color="neutral"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={COPY_BUTTON_CLASS}
      data-state="idle"
      data-testid="chat-message-user-edit-btn"
      sx={ICON_BUTTON_SX}
    >
      <PenIcon />
    </IconButton>
  );
}

/**
 * The inline editor a sent prompt turns into. Enter sends and Shift+Enter breaks the line, as in
 * the composer; Escape cancels. `onSend` resolves false when main refused the edit, and the
 * editor then stays open with the text, the reason being shown where send errors are.
 */
export function PromptEditor({
  initialText,
  warning,
  disabled,
  onSend,
  onCancel,
}: {
  initialText: string;
  warning: RewindWarning;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const blocked = disabled || sending || !text.trim();

  const send = async () => {
    if (blocked) return;
    setSending(true);
    try {
      await onSend(text);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <Stack spacing={0.75} sx={{ width: '85%', minWidth: 0 }} data-testid="chat-message-user-editor">
      <Textarea
        autoFocus
        minRows={2}
        maxRows={12}
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={event => event.target.setSelectionRange(event.target.value.length, event.target.value.length)}
        slotProps={{ textarea: { 'aria-label': 'Edit message', 'data-testid': 'chat-message-user-editor-input' } }}
      />
      {warning !== 'none' && (
        <Typography
          level="body-xs"
          color={warning === 'changes' ? 'warning' : 'neutral'}
          data-testid="chat-message-user-editor-warning"
          data-warning={warning}
        >
          {REWIND_WARNING_TEXT[warning]}
        </Typography>
      )}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onCancel}
          data-testid="chat-message-user-editor-cancel-btn"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={blocked}
          loading={sending}
          onClick={() => void send()}
          data-testid="chat-message-user-editor-send-btn"
        >
          Send
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * Regenerate on the last reply. When that reply's tools changed things, the first click asks
 * first and says what is not undone; otherwise it regenerates straight away.
 */
export function RegenerateButton({ onRegenerate, changes }: { onRegenerate: () => void; changes: boolean }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" data-testid="chat-message-assistant-regenerate-confirm">
        <Typography level="body-xs" color="warning" sx={{ whiteSpace: 'nowrap' }}>
          {REGENERATE_WARNING_TEXT}
        </Typography>
        <Button
          size="sm"
          variant="soft"
          color="warning"
          onClick={() => {
            setConfirming(false);
            onRegenerate();
          }}
          data-testid="chat-message-assistant-regenerate-confirm-btn"
        >
          Regenerate
        </Button>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setConfirming(false)}
          data-testid="chat-message-assistant-regenerate-cancel-btn"
        >
          Cancel
        </Button>
      </Stack>
    );
  }

  return (
    <Box component="span" sx={{ display: 'inline-flex' }}>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="Regenerate reply"
        title="Regenerate reply"
        onClick={() => (changes ? setConfirming(true) : onRegenerate())}
        className={COPY_BUTTON_CLASS}
        data-state="idle"
        data-testid="chat-message-assistant-regenerate-btn"
        sx={ICON_BUTTON_SX}
      >
        <ReloadIcon />
      </IconButton>
    </Box>
  );
}
