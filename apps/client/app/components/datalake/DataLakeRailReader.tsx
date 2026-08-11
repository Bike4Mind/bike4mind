import { Box, IconButton, Skeleton, Tooltip, Typography, useTheme } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import { useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import { gray } from '@client/app/utils/themes/colors';
import type { IFabFileDocument } from '@bike4mind/common';

interface DataLakeRailReaderProps {
  file: IFabFileDocument;
  onBack: () => void;
}

/**
 * Inline read-only reader that takes the chat tree's place in the Data Lake rail (View action).
 * Deliberately session-free: reading a lake file must not attach it to the chat or require a
 * session to exist - see the auto-attach removal spec. Wider than the 260px tree for comfort.
 */
export default function DataLakeRailReader({ file, onBack }: DataLakeRailReaderProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { data: content, isLoading } = useGetFabFileContent(file);
  const title = file.fileName.replace(/\.[^/.]+$/, '').replace(/^\[.*?\]\s*/, '');

  return (
    <Box
      data-testid="datalake-rail-reader"
      sx={{
        width: 420,
        minWidth: 320,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Same shell treatment as the chat tree rail it replaces (DataLakeChatTree containerSx).
        backgroundColor: 'background.surface2',
        border: '1px solid',
        borderColor: isDark ? gray[800] : gray[200],
        borderRadius: '10px',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          p: '8px 12px',
          borderBottom: '1px solid',
          borderColor: isDark ? gray[800] : gray[200],
        }}
      >
        <Tooltip title="Back to files" size="sm">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={onBack}
            aria-label="Back to files"
            data-testid="datalake-reader-back-btn"
          >
            <ArrowBackIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Typography noWrap sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
          {title}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 1.5 }}>
        {isLoading ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Skeleton variant="text" level="body-md" sx={{ width: '100%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '90%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '95%' }} />
          </Box>
        ) : content ? (
          <MarkdownViewer content={content} />
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Unable to load file content.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
