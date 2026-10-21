import React from 'react';
import { Box, IconButton, Typography, CircularProgress, Tooltip } from '@mui/joy';
import { Close as CloseIcon, ErrorOutline as ErrorIcon } from '@mui/icons-material';
import { IFabFileDocument } from '@bike4mind/common';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import { gray } from '@client/app/utils/themes/colors';

interface MessageFileItem {
  fabFile: IFabFileDocument;
  uploadProgress: number;
  // 'scanning'/'blocked' cover an uploaded image pending/failing the async content-moderation
  // scan. GetFileIcon renders the ImageModerationPlaceholder for those based on
  // fabFile.moderationStatus, so no extra overlay is needed here beyond gating the
  // click-to-open affordance (below) to 'complete'.
  status: 'uploading' | 'complete' | 'error' | 'scanning' | 'blocked';
}

interface MessageFileThumbnailsProps {
  files: MessageFileItem[];
  onRemove: (fileId: string) => void;
  onClick?: (file: IFabFileDocument) => void;
}

const TILE = 48; // px, images are square tiles, documents a tile-tall chip

/** "PDF - 1.2 MB" (joined with a middle dot) - the extension (or mime subtype) and the size, for a document chip. */
const fileMeta = (file: IFabFileDocument) => {
  const ext = file.fileName.includes('.') ? file.fileName.split('.').pop() : file.mimeType?.split('/').pop();
  const type = ext ? ext.toUpperCase() : undefined;
  const size = file.fileSize > 0 ? formatSize(file.fileSize) : undefined;
  return [type, size].filter(Boolean).join(' \u00b7 ');
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The files attached to the message being written, as compact tiles above its text inside the
 * composer (SessionBottom): images as square previews, documents as a chip with name, type and
 * size. The remove button shows on hover (always on touch screens).
 */
export const MessageFileThumbnails: React.FC<MessageFileThumbnailsProps> = ({ files, onRemove, onClick }) => {
  if (files.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '8px', mb: '12px' }} data-testid="message-file-thumbnails">
      {files.map(item => {
        const { fabFile, status } = item;
        const isImage = !!fabFile.mimeType?.startsWith('image/');
        const clickable = !!onClick && status === 'complete';
        return (
          <Box
            key={fabFile.id || fabFile.fileName}
            onClick={() => clickable && onClick?.(fabFile)}
            data-testid={`message-file-thumbnail-${fabFile.id}`}
            sx={theme => ({
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              height: `${TILE}px`,
              ...(isImage ? { width: `${TILE}px` } : { maxWidth: '240px', pl: '8px', pr: '12px' }),
              borderRadius: '8px',
              // Not surface2 like the Tools cards: in dark mode that is the composer's own panel colour,
              // so the tile would vanish. Darker than the panel in dark mode, white in light.
              backgroundColor: theme.palette.mode === 'light' ? gray[0] : theme.palette.background.body,
              outline: status === 'error' ? `1px solid ${theme.vars.palette.danger.outlinedBorder}` : 'none',
              cursor: clickable ? 'pointer' : 'default',
              '&:hover .message-file-remove, &:focus-within .message-file-remove': { opacity: 1 },
              '@media (hover: none)': { '& .message-file-remove': { opacity: 1 } },
            })}
          >
            <Box
              sx={{
                position: 'relative',
                flexShrink: 0,
                width: isImage ? `${TILE}px` : '32px',
                height: isImage ? `${TILE}px` : '32px',
                borderRadius: isImage ? '8px' : '6px',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'text.tertiary',
                // An image slot keeps its own lighter square, so the scan placeholder or the fallback icon
                // shown until a preview loads does not melt into the tile. Document icons sit on the tile.
                backgroundColor: theme =>
                  !isImage ? 'transparent' : theme.palette.mode === 'light' ? gray[50] : theme.palette.border.solid,
                '& > img': { borderRadius: 0 },
                '& > :not(img)': { backgroundColor: 'transparent' },
              }}
            >
              <GetFileIcon file={fabFile} size={22} previewSize={isImage ? TILE : 32} />
              {(status === 'uploading' || status === 'error') && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                  }}
                >
                  {status === 'uploading' ? (
                    <CircularProgress
                      size="sm"
                      determinate
                      value={item.uploadProgress}
                      sx={{ '--CircularProgress-size': '20px' }}
                      data-testid={`message-file-progress-${fabFile.id}`}
                    />
                  ) : (
                    <ErrorIcon sx={{ fontSize: 20, color: 'danger.300' }} />
                  )}
                </Box>
              )}
            </Box>

            {!isImage && (
              <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Tooltip title={fabFile.fileName} placement="top">
                  <Typography level="body-sm" noWrap sx={{ color: 'text.primary', lineHeight: 1.3 }}>
                    {fabFile.fileName}
                  </Typography>
                </Tooltip>
                <Typography level="body-xs" noWrap sx={{ color: status === 'error' ? 'danger.400' : 'text.tertiary' }}>
                  {status === 'error' ? 'Upload failed' : fileMeta(fabFile)}
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
                '--IconButton-size': '20px',
                minWidth: 20,
                minHeight: 20,
                borderRadius: '50%',
                zIndex: 2,
                opacity: 0,
                transition: 'opacity 0.15s',
              }}
              data-testid={`remove-message-file-${fabFile.id}`}
            >
              <CloseIcon sx={{ fontSize: '14px' }} />
            </IconButton>
          </Box>
        );
      })}
    </Box>
  );
};
