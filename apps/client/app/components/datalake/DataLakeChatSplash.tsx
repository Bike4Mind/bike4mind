import { Box, Typography, useTheme } from '@mui/joy';
import { alpha } from '@mui/system';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';

/**
 * Empty-state splash for the chat-first Data Lake surface (#836), shown in the chat pane
 * before the first message. Carries the "Data Lake Explorer" tagline from the previous
 * surface so opening a lake reads as a purposeful, grounded search experience.
 */
export default function DataLakeChatSplash() {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const cyan = inkFor(HUES.cyan, isDark);
  const violet = inkFor(HUES.violet, isDark);

  return (
    <Box
      data-testid="datalake-chat-splash"
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 1.5,
        px: 4,
      }}
    >
      <Box
        aria-hidden
        sx={{
          fontSize: 44,
          lineHeight: 1,
          filter: `drop-shadow(0 2px 10px ${alpha(cyan, 0.45)})`,
        }}
      >
        ⛩
      </Box>
      <Typography
        level="h3"
        sx={{
          fontWeight: 700,
          letterSpacing: '0.01em',
          background: `linear-gradient(90deg, ${cyan}, ${violet})`,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}
      >
        Data Lake Explorer
      </Typography>
      <Typography level="body-md" sx={{ color: 'text.secondary', maxWidth: 460 }}>
        Search and explore the knowledge base across products, competitors, and playbooks.
      </Typography>
      <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 0.5 }}>
        Ask anything below — answers are grounded in this data lake.
      </Typography>
    </Box>
  );
}
