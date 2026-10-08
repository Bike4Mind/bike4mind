import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatQueuedMessage } from '@shared/chat';
import { CloseIcon, SkipAheadIcon } from './icons';
import { contentColumnSx } from './layout';
import { queuedPreview } from './queuedMessages';

/**
 * What is waiting to be sent, above the composer.
 *
 * Deliberately not styled like a sent message: a queued one has to read as still in the user's
 * hands, so it sits outside the transcript, above the input it came from, and carries the one
 * control that takes it back. A queue nobody can see into or cancel would be worse than no
 * queue at all - the user would have no way to tell what is about to be said on their behalf.
 *
 * Normally exactly one row: sending again while a message is pending appends to that message.
 * It still maps over a list so a release that hands back more than one has somewhere to draw.
 */
export function QueuedMessageList({
  messages,
  onCancel,
  onSendNow,
  canSendNow = false,
}: {
  messages: readonly ChatQueuedMessage[];
  onCancel: (queuedId: string) => void;
  /** Interrupt the live reply and run this one next. Omitted where there is nothing to interrupt. */
  onSendNow?: (queuedId: string) => void;
  /**
   * Whether a reply is actually running. Without one the control would have nothing to cut in
   * front of: the queue is about to drain by itself, so "now" and "wait" mean the same thing.
   */
  canSendNow?: boolean;
}) {
  if (messages.length === 0) return null;

  return (
    <Stack spacing={0.5} sx={{ ...contentColumnSx, pt: 1.5 }} data-testid="composer-queued-list">
      {messages.map(message => (
        <Stack
          key={message.id}
          direction="row"
          alignItems="flex-start"
          spacing={1}
          sx={{
            borderRadius: 'sm',
            border: '1px dashed',
            borderColor: 'neutral.outlinedBorder',
            bgcolor: 'background.level1',
            px: 1,
            py: 0.75,
          }}
          data-testid="composer-queued-message"
          data-relay={message.relay ? 'true' : undefined}
        >
          {/* A relayed message is named by its sender, not labelled "Queued": the user did not
              write it, and a row that does not say so reads as their own text about to go out. */}
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            noWrap
            sx={{ flexShrink: 0, alignSelf: 'flex-start', pt: 0.25, maxWidth: 160 }}
          >
            {message.automatic ? 'Auto-fix' : message.relay ? `From ${message.relay.fromTitle}` : 'Queued'}
          </Typography>

          <Typography
            level="body-sm"
            sx={{
              flex: 1,
              minWidth: 0,
              whiteSpace: 'pre-wrap',
              // A message that grew by appending stays readable, without letting a long one
              // push the composer down the screen.
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {queuedPreview(message)}
          </Typography>

          {message.attachments && message.attachments.length > 0 && (
            <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0 }}>
              +{message.attachments.length}
            </Typography>
          )}

          {/* Never on a relay: jumping the user's own turn with another conversation's words is
              not something they asked for. Main refuses it too - this is so the row agrees. */}
          {canSendNow && onSendNow && !message.relay && !message.automatic && (
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => onSendNow(message.id)}
              aria-label="Stop the reply and send this message now"
              title="Send now"
              data-testid="composer-send-now-queued-btn"
            >
              <SkipAheadIcon />
            </IconButton>
          )}

          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            sx={{ alignSelf: 'flex-start' }}
            onClick={() => onCancel(message.id)}
            aria-label={message.relay ? 'Do not run this message' : 'Cancel this queued message'}
            data-testid="composer-cancel-queued-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
      ))}
    </Stack>
  );
}
