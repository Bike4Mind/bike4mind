import { useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import { AttachmentRow } from './Attachments';
import { contentColumnSx } from './layout';
import { toAttachmentInputs, type AttachmentDraft } from './useAttachments';

export function Composer({
  sessionId,
  disabled,
  streaming,
  attachments,
  blockedReason,
  placeholder = 'Send a message...',
  onSend,
  onStop,
  footer,
  status,
}: {
  sessionId: string | null;
  disabled: boolean;
  streaming: boolean;
  attachments: AttachmentDraft;
  /** Prompt for an empty composer. A Code session asks for a task, a Chat session for a message. */
  placeholder?: string;
  /**
   * Why this turn cannot be sent as composed - today only an image on a model known not to
   * read them. Shown in full and blocks Send: the alternative is a request the server rejects
   * for reasons the user never sees.
   */
  blockedReason?: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Controls that belong to the next turn rather than to the app - the model picker. */
  footer?: ReactNode;
  /**
   * What the turn in flight is doing, when one is. It TAKES OVER this slot rather than sitting
   * beside the idle indicator below: two status elements a foot apart are two things that can
   * disagree about whether a reply is running, and the reader has no way to tell which is right.
   */
  status?: ReactNode;
}) {
  const [text, setText] = useState('');

  const hasContent = text.trim().length > 0 || attachments.attachments.length > 0;
  const blocked = !!blockedReason;

  const submit = () => {
    if (!hasContent || disabled || streaming || attachments.busy || blocked) return;
    const prompt = text.trim();
    setText('');
    onSend(prompt);
  };

  // Enter sends, Shift+Enter breaks the line - the convention every chat client here shares.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  /**
   * The screenshot path, and the one that has to feel free: cmd-shift-4 then cmd-v.
   *
   * Only claims the paste when the clipboard actually carries files. Pasting text alongside an
   * image (a browser copy) must still land in the textarea, so the default is left alone unless
   * there is nothing but files to take.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void toAttachmentInputs(files).then(inputs => attachments.add(inputs));
  };

  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
      {attachments.rejected.length > 0 && (
        <Alert
          size="sm"
          color="warning"
          variant="soft"
          sx={{ ...contentColumnSx, mt: 1, cursor: 'pointer' }}
          onClick={attachments.dismissRejected}
          data-testid="attachment-rejected"
        >
          <Stack>
            {attachments.rejected.map(item => (
              <Typography key={`${item.name}:${item.reason}`} level="body-xs">
                {item.name}: {item.reason}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}

      {blockedReason && (
        <Alert
          size="sm"
          color="warning"
          variant="soft"
          sx={{ ...contentColumnSx, mt: 1 }}
          data-testid="attachment-vision-block"
        >
          {blockedReason}
        </Alert>
      )}

      {attachments.attachments.length > 0 && (
        <Box sx={{ ...contentColumnSx, pt: 1.5 }}>
          <AttachmentRow sessionId={sessionId} attachments={attachments.attachments} onRemove={attachments.remove} />
        </Box>
      )}

      <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ ...contentColumnSx, pt: 1.5 }}>
        <Textarea
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? 'Pick a conversation to start typing' : placeholder}
          disabled={disabled}
          minRows={1}
          maxRows={8}
          sx={{ flex: 1 }}
          // onPaste goes on the inner textarea, not Joy's root: the root is a div, and typing
          // the handler for it would lose the element the paste actually happened in.
          slotProps={{ textarea: { 'data-testid': 'chat-composer-input', onPaste } }}
        />

        {streaming ? (
          <Button variant="soft" color="neutral" onClick={onStop} data-testid="chat-stop-btn">
            Stop
          </Button>
        ) : (
          <Button
            onClick={submit}
            disabled={disabled || !hasContent || attachments.busy || blocked}
            data-testid="chat-send-btn"
          >
            Send
          </Button>
        )}
      </Stack>

      {/* Attach on the left, what answers the turn on the right - the shape Claude Code uses. */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1 }}>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          disabled={disabled || attachments.busy}
          onClick={() => void attachments.pick()}
          aria-label="Attach a file"
          data-testid="composer-attach-btn"
        >
          <Typography level="body-lg">+</Typography>
        </IconButton>

        <Box sx={{ flex: 1 }} />

        {footer}

        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }} data-testid="composer-status">
          {status ?? (
            <>
              <Box
                sx={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  bgcolor: streaming ? 'primary.solidBg' : disabled ? 'neutral.softBg' : 'success.solidBg',
                }}
              />
              <Typography level="body-xs" textColor="text.tertiary">
                {streaming ? 'Working' : disabled ? 'No session' : 'Ready'}
              </Typography>
            </>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
