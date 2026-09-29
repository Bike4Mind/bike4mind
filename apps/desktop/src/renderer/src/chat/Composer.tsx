import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import type { ChatQueuedMessage } from '@shared/chat';
import { AttachmentRow } from './Attachments';
import { composerKeyAction, composerPlaceholder, shownSuggestion } from './composerInput';
import { contentColumnSx } from './layout';
import { QueuedMessageList } from './QueuedMessageList';
import { mergeIntoDraft } from './queuedMessages';
import { toAttachmentInputs, type AttachmentDraft } from './useAttachments';

export function Composer({
  sessionId,
  disabled,
  streaming,
  attachments,
  blockedReason,
  notReady,
  placeholder = 'Send a message...',
  onSend,
  onStop,
  queued,
  onCancelQueued,
  returned,
  onReturnedConsumed,
  footer,
  leading,
  suggestion,
  onSuggestionDismissed,
}: {
  sessionId: string | null;
  disabled: boolean;
  streaming: boolean;
  attachments: AttachmentDraft;
  /** Prompt for an empty composer. A Code session asks for a task, a Chat session for a message. */
  placeholder?: string;
  /**
   * Why this turn cannot be sent as composed - an image on a model known not to read them, or
   * a Code session with no project folder chosen. Shown in full and blocks Send: the
   * alternative is a request that is refused for reasons the user never sees.
   */
  blockedReason?: string | null;
  /**
   * A word for the idle indicator naming a state that is not ready to send - "No folder" for a
   * Code session with no project. It blocks Send and draws NO banner: the control that answers
   * it is a few pixels above, and a line of prose repeating what that control already says is
   * noise. Main refuses the turn regardless; this is so the button agrees with it.
   */
  notReady?: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Typed ahead of the live turn, waiting to be sent. Drawn above the input. */
  queued?: readonly ChatQueuedMessage[];
  onCancelQueued?: (queuedId: string) => void;
  /**
   * Messages the queue handed back, to take into the draft. Anything the user is midway
   * through typing is kept: the returned text is appended to it, never swapped for it.
   * `onReturnedConsumed` acknowledges the batch so it is taken in exactly once.
   */
  returned?: { id: number; messages: ChatQueuedMessage[] } | null;
  onReturnedConsumed?: () => void;
  /** Controls that belong to the next turn rather than to the app - the model picker. */
  footer?: ReactNode;
  /**
   * Sits beside the attach button, on the left of the same row - the approval-mode pill. Its
   * place is load-bearing: a permission the user cannot see without opening something is a
   * permission they will forget they granted.
   */
  leading?: ReactNode;
  /**
   * A guess at the next message, drawn greyed out INSIDE the empty input - the one place a user
   * looking at a finished reply is already looking. Tab takes it into the draft.
   *
   * It is a draft and never a turn. Tab fills the box and stops there; Enter still sends
   * whatever is actually in the box, so taking a suggestion and sending it are two separate
   * keystrokes with the user's own decision in between. Nothing here submits, and there is no
   * setting that makes it - a hint that sent itself would let model output choose the next turn.
   */
  suggestion?: string | null;
  /** The hint is gone - the user typed over it, or took it. Asks the owner to drop it. */
  onSuggestionDismissed?: () => void;
}) {
  const [text, setText] = useState('');

  const hasContent = text.trim().length > 0 || attachments.attachments.length > 0;
  const blocked = !!blockedReason || !!notReady;

  // See composerInput.ts for what wins here and why.
  const shown = shownSuggestion({ disabled, text, suggestion });
  // `streaming` is NOT here: a send during a live turn is queued, not dropped. It used to be
  // the first condition, which is why pressing Enter mid-reply did nothing at all.
  const canSubmit = hasContent && !disabled && !attachments.busy && !blocked;

  const submit = () => {
    if (!canSubmit) return;
    const prompt = text.trim();
    setText('');
    onSend(prompt);
  };

  // Text coming back out of the queue - cancelled, or its turn stopped or failed. Tracked by
  // batch id rather than by content, so cancelling the same message twice lands twice, and so a
  // re-render between the merge and the acknowledgement cannot merge it again.
  const consumedReturn = useRef<number | null>(null);
  useEffect(() => {
    if (!returned || consumedReturn.current === returned.id) return;
    consumedReturn.current = returned.id;
    setText(current => mergeIntoDraft(current, returned.messages));
    onReturnedConsumed?.();
  }, [returned, onReturnedConsumed]);

  // Enter sends, Shift+Enter breaks the line, Tab takes the hint. Which is which lives in
  // composerInput.ts, where the rule that accepting is not sending is stated and tested.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction(event.key, event.shiftKey, !!shown);
    if (action === 'default') return;
    event.preventDefault();
    if (action === 'submit') {
      submit();
      return;
    }
    // Fills the draft and stops. The user still has to press Enter, on text they can now read
    // and edit - which is the whole reason this is a different key from the one that sends.
    if (shown) {
      setText(shown);
      onSuggestionDismissed?.();
    }
  };

  /**
   * The user is composing their own message, so the hint stops being one.
   *
   * Dropped rather than hidden: it is thrown away on the first keystroke and the ordinary
   * placeholder is what comes back if they delete it all again, because a hint that reappeared
   * under a box the user has already emptied once would be offering the same guess about a
   * conversation they have moved on from. Covers paste and drop too - both change the value.
   */
  const onTextChange = (next: string) => {
    setText(next);
    if (suggestion && next.length > 0) onSuggestionDismissed?.();
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
    <Box>
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
          data-testid="composer-blocked-reason"
        >
          {blockedReason}
        </Alert>
      )}

      <QueuedMessageList messages={queued ?? []} onCancel={onCancelQueued ?? (() => undefined)} />

      {attachments.attachments.length > 0 && (
        <Box sx={{ ...contentColumnSx, pt: 1.5 }}>
          <AttachmentRow sessionId={sessionId} attachments={attachments.attachments} onRemove={attachments.remove} />
        </Box>
      )}

      <Box sx={{ ...contentColumnSx, pt: 1.5 }}>
        {/* Send and Stop ride INSIDE the input rather than beside it. As siblings in a row they
            took their own width out of the column, so the input's right edge stopped ~74px short
            of where the transcript ends while every other composer row reached it. */}
        <Textarea
          value={text}
          onChange={event => onTextChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={composerPlaceholder({ disabled, text, suggestion, placeholder })}
          disabled={disabled}
          minRows={1}
          maxRows={8}
          endDecorator={
            /* Both at once while a reply runs: stopping this turn and queueing the next one are
               different intentions, and swapping one control for the other made the second
               unreachable. Send is labelled for what the click actually does. */
            <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
              {streaming && (
                <Button size="sm" variant="soft" color="neutral" onClick={onStop} data-testid="chat-stop-btn">
                  Stop
                </Button>
              )}
              <Button size="sm" onClick={submit} disabled={!canSubmit} data-testid="chat-send-btn">
                {streaming ? 'Queue' : 'Send'}
              </Button>
            </Stack>
          }
          // onPaste goes on the inner textarea, not Joy's root: the root is a div, and typing
          // the handler for it would lose the element the paste actually happened in.
          slotProps={{
            textarea: {
              'data-testid': 'chat-composer-input',
              onPaste,
              // So the hint is distinguishable from the ordinary placeholder without reading
              // the text, and so a screen reader is told Tab does something here.
              ...(shown ? { 'data-suggested-prompt': shown, 'aria-keyshortcuts': 'Tab' } : {}),
            },
          }}
        />
      </Box>

      {/* Attach on the left, what answers the turn on the right - the shape Claude Code uses. */}
      {/* `gap` rather than Stack's `spacing`: spacing resets every child's margin from the row
          itself, which outranks the attach button's own negative margin below. */}
      <Stack direction="row" alignItems="center" sx={{ ...contentColumnSx, py: 1, gap: 1 }}>
        {/* Pulled left by the inset its own 32px box puts around a centred glyph, so the '+' the
            user sees starts on the column's left edge - the line the transcript and the input's
            border already sit on. Without it the glyph alone hangs ~10px inside that line. */}
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          disabled={disabled || attachments.busy}
          onClick={() => void attachments.pick()}
          aria-label="Attach a file"
          sx={{ ml: '-10px' }}
          data-testid="composer-attach-btn"
        >
          <Typography level="body-lg">+</Typography>
        </IconButton>

        {leading}

        <Box sx={{ flex: 1 }} />

        {footer}

        {/* Always here now, and it is the only thing that says WHETHER a reply is running. The
            line at the foot of the reply says what that reply is DOING, and never claims a turn
            this dot does not - so the two report different facts rather than the same fact
            twice, which is what made a second indicator wrong before.

            They are not redundant either: this dot knows about a turn the window never saw
            start (a reload mid-reply), where the transcript line has no clock or token count to
            show and correctly shows nothing. */}
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }} data-testid="composer-status">
          <Box
            sx={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: streaming
                ? 'primary.solidBg'
                : disabled
                  ? 'neutral.softBg'
                  : notReady
                    ? 'warning.solidBg'
                    : 'success.solidBg',
            }}
          />
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {streaming ? 'Working' : disabled ? 'No session' : (notReady ?? 'Ready')}
          </Typography>
        </Stack>
      </Stack>
    </Box>
  );
}
