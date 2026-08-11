import { Box, IconButton, Tooltip, Typography, useTheme } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import KnowledgeViewer from '@client/app/components/Knowledge/KnowledgeViewer';
import { gray } from '@client/app/utils/themes/colors';

interface DataLakeRailViewerProps {
  onBack: () => void;
}

/**
 * The KnowledgeViewer, mounted in the Data Lake rail for hosts whose chat is docked OUTSIDE the
 * explorer (the premium overlay). Those hosts run the `dockRight` layout, in which the chat's own
 * SessionContainer renders no viewer at all, and the layout cannot be switched to get one - the
 * host force-redocks anything else, and `vertical` collapses the dock. Mounting our own instance
 * is what makes View behave the same here as it does with the chat embedded.
 *
 * `autoHideOnEmpty={false}` is load-bearing: the viewer otherwise pushes the global layout to
 * `hide` whenever it has nothing to show, which would take the host's docked chat down with it.
 */
export default function DataLakeRailViewer({ onBack }: DataLakeRailViewerProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  return (
    <Box
      data-testid="datalake-rail-viewer"
      sx={{
        width: 520,
        minWidth: 320,
        flex: '0 1 520px',
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
            data-testid="datalake-viewer-back-btn"
          >
            <ArrowBackIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Typography noWrap sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
          Files
        </Typography>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <KnowledgeViewer autoHideOnEmpty={false} />
      </Box>
    </Box>
  );
}
