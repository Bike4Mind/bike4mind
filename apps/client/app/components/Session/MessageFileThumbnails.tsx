import React, { useState } from 'react';
import { Box, IconButton, Typography, CircularProgress, Tooltip } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import ErrorIcon from '@mui/icons-material/ErrorOutline';
import { IFabFileDocument } from '@bike4mind/common';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import { gray } from '@client/app/utils/themes/colors';
import type { PendingMessageFile } from '@client/app/hooks/useSessionLayout';
import { LocalFilePreview, fileExtension, localPreviewKind } from './LocalFilePreview';

type MessageFileItem = Pick<
  PendingMessageFile,
  'fabFile' | 'uploadProgress' | 'status' | 'localFile' | 'clientId' | 'errorMessage'
>;

interface MessageFileThumbnailsProps {
  files: MessageFileItem[];
  onRemove: (fileId: string) => void;
  onClick?: (file: IFabFileDocument) => void;
}

const TILE = 100; // px, square preview
const CHIP_HEIGHT = 48; // px, document chip

const spinnerSx = {
  '--CircularProgress-size': '20px',
  '--CircularProgress-thickness': '2px',
  '--CircularProgress-trackColor': 'rgba(255, 255, 255, 0.3)',
  '--CircularProgress-progressColor': '#fff',
};

/** "PDF - 1.2 MB" (joined with a middle dot) - the extension (or mime subtype) and the size, for a document chip. */
const fileMeta = (file: IFabFileDocument) => {
  const type = (fileExtension(file.fileName) || file.mimeType?.split('/').pop())?.toUpperCase();
  const size = file.fileSize > 0 ? formatSize(file.fileSize) : undefined;
  return [type, size].filter(Boolean).join(' \u00b7 ');
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

interface TileStatusOverlayProps {
  item: MessageFileItem;
  /** Over a local preview the dimming is lighter, so the preview still reads. */
  overPreview: boolean;
}

const TileStatusOverlay: React.FC<TileStatusOverlayProps> = ({ item, overPreview }) => (
  <Box
    className="message-file-layer"
    sx={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: overPreview ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.5)',
    }}
  >
    {item.status === 'scanning' ? (
      <CircularProgress size="sm" sx={spinnerSx} />
    ) : item.status === 'uploading' ? (
      <CircularProgress
        size="sm"
        determinate
        value={item.uploadProgress}
        sx={spinnerSx}
        data-testid={`message-file-progress-${item.fabFile.id}`}
      />
    ) : (
      <Tooltip title={item.errorMessage ?? 'Upload failed'} placement="top" sx={{ maxWidth: 280 }}>
        <ErrorIcon sx={{ fontSize: 20, color: 'danger.400' }} data-testid={`message-file-error-${item.fabFile.id}`} />
      </Tooltip>
    )}
  </Box>
);

interface MessageFileTileProps {
  item: MessageFileItem;
  onRemove: (fileId: string) => void;
  onClick?: (file: IFabFileDocument) => void;
}

const MessageFileTile: React.FC<MessageFileTileProps> = ({ item, onRemove, onClick }) => {
  const { fabFile, status, localFile } = item;
  const [previewFailed, setPreviewFailed] = useState(false);

  // The browser's type for the local file wins: the server resolves by extension, and reports a
  // .webm video as audio/webm.
  const kind = localPreviewKind({ fileName: fabFile.fileName, mimeType: localFile?.type || fabFile.mimeType });
  const isImage = kind === 'image';
  const clickable = !!onClick && status === 'complete';
  const unsettled = status === 'uploading' || status === 'scanning' || status === 'error';
  // An image switches to its served copy once attached; other files have no served preview, so the
  // local one stays. Kept on 'error' too: a failed upload has nothing else to show.
  const preview = localFile && kind && !previewFailed && (!isImage || unsettled) ? { file: localFile, kind } : null;
  const square = isImage || !!preview;
  const blurred = !!preview && unsettled;
  // Without a preview, GetFileIcon already draws the scan placeholder.
  const showOverlay = status === 'uploading' || status === 'error' || (status === 'scanning' && !!preview);
  const ext = fileExtension(fabFile.fileName);

  return (
    <Box
      onClick={() => clickable && onClick?.(fabFile)}
      // Not on 'error': the error icon's tooltip would show under this one.
      title={square && !isImage && status !== 'error' ? fabFile.fileName : undefined}
      data-testid={`message-file-thumbnail-${fabFile.id}`}
      sx={theme => ({
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        height: `${square ? TILE : CHIP_HEIGHT}px`,
        ...(square ? { width: `${TILE}px` } : { maxWidth: '240px', pl: '8px', pr: '12px' }),
        borderRadius: '8px',
        // Not surface2 like the Tools cards: in dark mode that is the composer's own panel colour,
        // so the tile would vanish. Darker than the panel in dark mode, white in light.
        backgroundColor: theme.palette.mode === 'light' ? gray[0] : theme.palette.background.body,
        outline: status === 'error' ? `1px solid ${theme.vars.palette.danger[400]}` : 'none',
        cursor: clickable ? 'pointer' : 'default',
        '&:hover .message-file-remove, &:focus-within .message-file-remove': { opacity: 1 },
        '@media (hover: none)': { '& .message-file-remove': { opacity: 1 } },
      })}
    >
      <Box
        sx={{
          position: 'relative',
          flexShrink: 0,
          width: square ? `${TILE}px` : '32px',
          height: square ? `${TILE}px` : '32px',
          borderRadius: square ? '8px' : '6px',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.tertiary',
          // A square slot keeps its own lighter background, so the scan placeholder or the fallback icon
          // shown until a preview loads does not melt into the tile. Document icons sit on the tile.
          backgroundColor: theme =>
            !square ? 'transparent' : theme.palette.mode === 'light' ? gray[50] : theme.palette.border.solid,
          '& > img': { borderRadius: 0 },
          '& > :not(img):not(.message-file-layer)': { backgroundColor: 'transparent' },
        }}
      >
        {preview ? (
          <Box
            className="message-file-layer"
            data-testid="message-file-local-preview"
            data-preview-kind={preview.kind}
            // Scaled up so the blur does not fade the square's edges.
            sx={{ width: '100%', height: '100%', ...(blurred && { filter: 'blur(6px)', transform: 'scale(1.15)' }) }}
          >
            <LocalFilePreview
              file={preview.file}
              kind={preview.kind}
              alt={fabFile.fileName}
              size={TILE}
              onError={() => setPreviewFailed(true)}
            />
          </Box>
        ) : (
          <GetFileIcon file={fabFile} size={22} previewSize={square ? TILE : 32} />
        )}

        {square && !isImage && ext && (
          <Typography
            className="message-file-layer"
            level="body-xs"
            sx={{
              position: 'absolute',
              left: '6px',
              bottom: '6px',
              px: '5px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 600,
              lineHeight: '16px',
              color: '#fff',
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
            }}
          >
            {ext.toUpperCase()}
          </Typography>
        )}

        {showOverlay && <TileStatusOverlay item={item} overPreview={!!preview} />}
      </Box>

      {!square && (
        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Tooltip title={fabFile.fileName} placement="top">
            <Typography level="body-sm" noWrap sx={{ color: 'text.primary', lineHeight: 1.3 }}>
              {fabFile.fileName}
            </Typography>
          </Tooltip>
          <Typography level="body-xs" noWrap sx={{ color: status === 'error' ? 'danger.400' : 'text.tertiary' }}>
            {status === 'error' ? (item.errorMessage ?? 'Upload failed') : fileMeta(fabFile)}
          </Typography>
        </Box>
      )}

      <IconButton
        className="message-file-remove"
        size="sm"
        variant="solid"
        color="neutral"
        aria-label={`Remove ${fabFile.fileName}`}
        onClick={e => {
          e.stopPropagation(); // Prevent triggering the tile's onClick
          onRemove(fabFile.id);
        }}
        sx={{
          position: 'absolute',
          top: '-6px',
          right: '-6px',
          '--IconButton-size': '18px',
          minWidth: 18,
          minHeight: 18,
          borderRadius: '50%',
          zIndex: 2,
          opacity: 0,
          transition: 'opacity 0.15s',
        }}
        data-testid={`remove-message-file-${fabFile.id}`}
      >
        <CloseIcon sx={{ fontSize: '12px' }} />
      </IconButton>
    </Box>
  );
};

// The temp id swaps for the server id when an upload resolves; keying on it would remount the
// tile and redraw its preview, so an upload keys on the client id it started with.
const tileKey = ({ fabFile, clientId }: MessageFileItem) => clientId ?? (fabFile.id || fabFile.fileName);

/**
 * The files attached to the message being written, as tiles above its text inside the composer
 * (SessionBottom): images, PDFs, videos and text as square previews, other documents as a chip
 * with name, type and size. The remove button shows on hover (always on touch screens).
 */
export const MessageFileThumbnails: React.FC<MessageFileThumbnailsProps> = ({ files, onRemove, onClick }) => {
  if (files.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '12px', mb: '20px' }} data-testid="message-file-thumbnails">
      {files.map(item => (
        <MessageFileTile key={tileKey(item)} item={item} onRemove={onRemove} onClick={onClick} />
      ))}
    </Box>
  );
};
