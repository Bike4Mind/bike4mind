import { useMemo, useState } from 'react';
import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatImageRef, ChatMedia } from '@shared/chat';
import { useImageMenu } from './ImageContextMenu';
import { ImageViewer } from './ImageViewer';

/**
 * Tall enough to be worth looking at, short enough that a square image does not push the rest
 * of the turn off screen. The image keeps its aspect ratio inside this box.
 */
const IMAGE_MAX_HEIGHT = 420;

/** A thumbnail inside a tool row's body, which sits among result text rather than standing alone. */
const THUMBNAIL_MAX_HEIGHT = 240;

type MediaVariant = 'full' | 'thumbnail';

/**
 * A box sized from the stored dimensions, so a thumbnail that has not loaded yet already holds
 * its place and a long thread does not jump as images arrive.
 */
function reservedBox(item: ChatMedia, maxHeight: number): { width: number; aspectRatio: string } | null {
  if (!item.width || !item.height) return null;
  const height = Math.min(maxHeight, item.height);
  return { width: Math.round((height * item.width) / item.height), aspectRatio: `${item.width} / ${item.height}` };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One line under the media: what was asked for, and how big the result is. */
function Caption({ item }: { item: ChatMedia }) {
  return (
    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5, wordBreak: 'break-word' }}>
      {item.caption}
      <Box component="span" sx={{ ml: 1, opacity: 0.7 }}>
        {formatBytes(item.byteLength)}
      </Box>
    </Typography>
  );
}

/**
 * A generated image or audio clip, rendered from a `b4m-media://` URL.
 *
 * The element loads the URL directly; there is no fetch and no base64 anywhere in the renderer.
 * Main serves the bytes over that scheme out of its own media folder, which is the only origin
 * the CSP admits for media - see index.html.
 */
type MediaNameHint = Extract<ChatImageRef, { source: 'media' }>['nameHint'];

function MediaItem({
  item,
  nameHint,
  variant = 'full',
}: {
  item: ChatMedia;
  nameHint?: MediaNameHint;
  variant?: MediaVariant;
}) {
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState(false);
  const imageRef = useMemo<ChatImageRef | null>(
    () => (item.kind === 'image' ? { source: 'media', url: item.url, nameHint } : null),
    [item.kind, item.url, nameHint]
  );
  const menu = useImageMenu(failed ? null : imageRef);

  if (failed) {
    return (
      <Sheet variant="soft" color="warning" sx={{ borderRadius: 'sm', px: 1.5, py: 1 }}>
        <Typography level="body-xs" data-testid="chat-media-failed">
          This {item.kind} could not be loaded. It may have been removed with an earlier version of this conversation.
        </Typography>
      </Sheet>
    );
  }

  if (item.kind === 'image') {
    const thumbnail = variant === 'thumbnail';
    const maxHeight = thumbnail ? THUMBNAIL_MAX_HEIGHT : IMAGE_MAX_HEIGHT;
    const box = thumbnail ? reservedBox(item, maxHeight) : null;
    return (
      <Box data-testid={thumbnail ? 'chat-media-thumbnail' : 'chat-media-image'}>
        <Box
          component="button"
          type="button"
          onClick={() => setViewing(true)}
          aria-label={`View ${item.caption} at full size`}
          sx={{ display: 'block', p: 0, border: 'none', bgcolor: 'transparent', cursor: 'zoom-in', maxWidth: '100%' }}
          {...menu}
          data-testid="chat-media-view-btn"
        >
          <Box
            component="img"
            src={item.url}
            alt={item.caption}
            loading={thumbnail ? 'lazy' : undefined}
            decoding="async"
            onError={() => setFailed(true)}
            sx={{
              display: 'block',
              maxWidth: '100%',
              maxHeight,
              ...(box ? { width: box.width, height: 'auto', aspectRatio: box.aspectRatio } : {}),
              borderRadius: 'sm',
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: thumbnail ? 'background.level1' : undefined,
            }}
          />
        </Box>
        {!thumbnail && <Caption item={item} />}
        <ImageViewer src={item.url} alt={item.caption} open={viewing} onClose={() => setViewing(false)} />
      </Box>
    );
  }

  return (
    <Box data-testid="chat-media-audio">
      {/* The browser's own controls rather than a bespoke player: play, scrub and volume are
          exactly what is wanted here, and Chromium's are keyboard accessible already. */}
      <Box
        component="audio"
        controls
        preload="metadata"
        src={item.url}
        onError={() => setFailed(true)}
        sx={{ width: '100%', maxWidth: 420, display: 'block' }}
      />
      <Caption item={item} />
    </Box>
  );
}

/**
 * `nameHint` names a saved copy: 'screenshot' for the browser's captures. 'thumbnail' is for
 * media drawn inside a tool row's body, where the row's own argument line already names it.
 */
export function MediaAttachments({
  media,
  nameHint,
  variant,
}: {
  media: ChatMedia[];
  nameHint?: MediaNameHint;
  variant?: MediaVariant;
}) {
  if (media.length === 0) return null;
  return (
    <Stack spacing={1} sx={{ mt: variant === 'thumbnail' ? 0.5 : 1 }} data-testid="chat-media-list">
      {media.map(item => (
        <MediaItem key={item.url} item={item} nameHint={nameHint} variant={variant} />
      ))}
    </Stack>
  );
}
