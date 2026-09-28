import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatAttachment } from '@shared/chat';

/** Side of a thumbnail, in px. Big enough to recognise a screenshot, small enough to sit in a row. */
const THUMBNAIL = 56;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The stored bytes of one attachment, fetched lazily.
 *
 * Lazy because the descriptor is what the session holds: a thread with twenty screenshots in it
 * would otherwise load twenty images' worth of base64 to render the message list.
 */
function useAttachmentContent(sessionId: string | null, attachment: ChatAttachment): string | null {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    void window.b4m.chat
      .readAttachment(sessionId, attachment.id, attachment.mediaType)
      .then(value => current && setContent(value));
    return () => {
      current = false;
    };
  }, [sessionId, attachment.id, attachment.mediaType]);

  return content;
}

function ImageTile({ sessionId, attachment }: { sessionId: string | null; attachment: ChatAttachment }) {
  const src = useAttachmentContent(sessionId, attachment);

  return (
    <Box
      sx={{
        width: THUMBNAIL,
        height: THUMBNAIL,
        borderRadius: 'sm',
        overflow: 'hidden',
        bgcolor: 'background.level2',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {src && (
        <Box
          component="img"
          src={src}
          alt={attachment.name}
          sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
          data-testid="attachment-thumbnail"
        />
      )}
    </Box>
  );
}

/**
 * One attachment as a tile: the image itself, or a name-and-size card for a text file.
 *
 * The size shown is the SOURCE size, not what was sent, and a truncated file says so - the
 * user attached a 50MB log and needs to know the model only got the head of it.
 */
export function AttachmentTile({
  sessionId,
  attachment,
  onRemove,
}: {
  sessionId: string | null;
  attachment: ChatAttachment;
  onRemove?: (attachmentId: string) => void;
}) {
  return (
    <Sheet
      variant="outlined"
      sx={{ position: 'relative', borderRadius: 'sm', p: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}
      data-testid="attachment-tile"
    >
      {attachment.kind === 'image' ? (
        <ImageTile sessionId={sessionId} attachment={attachment} />
      ) : (
        <Box
          sx={{
            width: THUMBNAIL,
            height: THUMBNAIL,
            borderRadius: 'sm',
            bgcolor: 'background.level2',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Typography level="body-xs" textColor="text.tertiary">
            TXT
          </Typography>
        </Box>
      )}

      <Stack sx={{ minWidth: 0, maxWidth: 180, pr: onRemove ? 2 : 0.5 }}>
        <Typography level="body-xs" noWrap title={attachment.name} data-testid="attachment-name">
          {attachment.name}
        </Typography>
        <Typography level="body-xs" textColor={attachment.truncated ? 'warning.plainColor' : 'text.tertiary'} noWrap>
          {formatBytes(attachment.sourceBytes)}
          {attachment.truncated ? ' - truncated' : ''}
        </Typography>
      </Stack>

      {onRemove && (
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={`Remove ${attachment.name}`}
          onClick={() => onRemove(attachment.id)}
          sx={{ position: 'absolute', top: 0, right: 0, minHeight: 20, minWidth: 20 }}
          data-testid="attachment-remove-btn"
        >
          <Typography level="body-xs">x</Typography>
        </IconButton>
      )}
    </Sheet>
  );
}

/** The row of attachments, above the composer while drafting and inside the bubble once sent. */
export function AttachmentRow({
  sessionId,
  attachments,
  onRemove,
}: {
  sessionId: string | null;
  attachments: readonly ChatAttachment[];
  onRemove?: (attachmentId: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap data-testid="attachment-row">
      {attachments.map(attachment => (
        <AttachmentTile key={attachment.id} sessionId={sessionId} attachment={attachment} onRemove={onRemove} />
      ))}
    </Stack>
  );
}
