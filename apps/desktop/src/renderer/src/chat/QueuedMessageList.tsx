import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatQueuedMessage } from '@shared/chat';
import { CloseIcon } from './icons';
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
}: {
  messages: readonly ChatQueuedMessage[];
  onCancel: (queuedId: string) => void;
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
        >
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ flexShrink: 0, alignSelf: 'flex-start', pt: 0.25 }}
          >
            Queued
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

          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            sx={{ alignSelf: 'flex-start' }}
            onClick={() => onCancel(message.id)}
            aria-label="Cancel this queued message"
            data-testid="composer-cancel-queued-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
      ))}
    </Stack>
  );
}
