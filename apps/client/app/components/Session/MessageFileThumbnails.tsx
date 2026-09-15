import React from 'react';
import { Box, IconButton, Typography, CircularProgress, Tooltip } from '@mui/joy';
import { Close as CloseIcon } from '@mui/icons-material';
import { IFabFileDocument } from '@bike4mind/common';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';

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

export const MessageFileThumbnails: React.FC<MessageFileThumbnailsProps> = ({ files, onRemove, onClick }) => {
  if (files.length === 0) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 1,
        p: 1,
        borderRadius: '8px',
        backgroundColor: theme => theme.palette.background.level1,
      }}
    >
      {files.map(item => (
        <Box
          key={item.fabFile.id || item.fabFile.fileName}
          sx={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0.5,
            p: 1,
            borderRadius: '6px',
            border: theme => `1px solid ${theme.palette.neutral.outlinedBorder}`,
            backgroundColor: theme => theme.palette.background.surface,
            width: '120px',
            transition: 'all 0.2s',
            cursor: onClick && item.status === 'complete' ? 'pointer' : 'default',
            '&:hover': {
              backgroundColor: theme => theme.palette.notebooklist.hoverBg,
            },
          }}
          onClick={() => {
            if (onClick && item.status === 'complete') {
              onClick(item.fabFile);
            }
          }}
          data-testid={`message-file-thumbnail-${item.fabFile.id}`}
        >
          {/* Remove Button */}
          <IconButton
            size="sm"
            variant="solid"
            color="neutral"
            onClick={e => {
              e.stopPropagation(); // Prevent triggering the parent onClick
              onRemove(item.fabFile.id);
            }}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 20,
              height: 20,
              minWidth: 20,
              minHeight: 20,
              borderRadius: '50%',
              zIndex: 2,
              opacity: 0.9,
              '&:hover': {
                opacity: 1,
              },
            }}
            data-testid={`remove-message-file-${item.fabFile.id}`}
          >
            <CloseIcon sx={{ fontSize: '14px' }} />
          </IconButton>

          {/* File Icon/Preview */}
          <Box
            sx={{
              position: 'relative',
              width: 64,
              height: 64,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <GetFileIcon file={item.fabFile} size={48} previewSize={64} />

            {/* Upload Progress Overlay */}
            {item.status === 'uploading' && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(0, 0, 0, 0.5)',
                  borderRadius: '4px',
                }}
              >
                <CircularProgress
                  size="sm"
                  determinate
                  value={item.uploadProgress}
                  sx={{ '--CircularProgress-size': '32px' }}
                />
              </Box>
            )}

            {/* Error State Overlay */}
            {item.status === 'error' && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(255, 0, 0, 0.1)',
                  border: theme => `2px solid ${theme.palette.danger.solidBg}`,
                  borderRadius: '4px',
                }}
              >
                <Typography level="body-xs" sx={{ color: 'danger.solidBg', fontWeight: 'bold' }}>
                  Error
                </Typography>
              </Box>
            )}
          </Box>

          {/* File Name */}
          <Tooltip title={item.fabFile.fileName} placement="top">
            <Typography
              level="body-xs"
              noWrap
              sx={{
                maxWidth: '100%',
                textAlign: 'center',
                color: theme => theme.palette.text.secondary,
              }}
            >
              {item.fabFile.fileName}
            </Typography>
          </Tooltip>
        </Box>
      ))}
    </Box>
  );
};
