import { Box, IconButton, Typography, useTheme } from '@mui/joy';
import { keyframes } from '@mui/system';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import CompressRoundedIcon from '@mui/icons-material/CompressRounded';

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
`;

interface ContextCompactionNoteProps {
  show: boolean;
  turns: number;
  onDismiss: () => void;
}

/**
 * Subtle, non-blocking, info-toned note shown when the last turn folded older
 * history into the running summary instead of re-sending it verbatim. Keeps the
 * automatic compaction from being invisible (the complaint behind #956/#996)
 * without alarming the user - it is a normal, healthy event, not a warning.
 */
export function ContextCompactionNote({ show, turns, onDismiss }: ContextCompactionNoteProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  if (!show) return null;

  const accent = isDarkMode ? '#93c5fd' : '#1e5fbf';
  const border = isDarkMode ? 'rgba(96, 165, 250, 0.35)' : 'rgba(30, 95, 191, 0.25)';
  const bg = isDarkMode ? 'rgba(30, 58, 95, 0.4)' : 'rgba(219, 234, 254, 0.7)';

  return (
    <Box
      data-testid="session-context-compaction-note"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: '8px',
        px: 1.5,
        py: 0.75,
        mb: 1,
        animation: `${fadeIn} 0.25s ease-out`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CompressRoundedIcon sx={{ fontSize: '18px', color: accent, flexShrink: 0 }} />
        <Typography data-testid="context-compaction-note-text" sx={{ fontSize: '12px', color: 'text.secondary' }}>
          Condensed {turns} earlier {turns === 1 ? 'turn' : 'turns'} into working memory to keep this conversation going.
        </Typography>
      </Box>
      <IconButton
        data-testid="context-compaction-note-dismiss"
        size="sm"
        variant="plain"
        onClick={onDismiss}
        aria-label="Dismiss compaction note"
        sx={{ color: accent, flexShrink: 0, minHeight: '22px', minWidth: '22px' }}
      >
        <CloseRoundedIcon sx={{ fontSize: '16px' }} />
      </IconButton>
    </Box>
  );
}
