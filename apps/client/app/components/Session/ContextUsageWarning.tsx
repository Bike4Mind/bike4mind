import { Box, IconButton, Typography, useTheme } from '@mui/joy';
import { keyframes } from '@mui/system';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { formatTokenCount, type SessionContextUsage } from '@client/app/hooks/useSessionContextUsage';

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
`;

interface ContextUsageWarningProps {
  show: boolean;
  usage: SessionContextUsage;
  modelName: string;
  onDismiss: () => void;
}

/**
 * Slim, non-blocking banner shown above the composer when a session's assembled
 * context approaches the model's ceiling. Unlike the credit warnings this does
 * NOT cover the input - the user must be able to keep typing while it shows.
 */
export function ContextUsageWarning({ show, usage, modelName, onDismiss }: ContextUsageWarningProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  if (!show) return null;

  const isDanger = usage.band === 'danger';
  const pct = Math.round(usage.utilizationPercentage);
  const used = formatTokenCount(usage.actualInputTokens);
  const max = formatTokenCount(usage.safeMaxInputTokens);

  const accent = isDanger ? (isDarkMode ? '#fca5a5' : '#b91c1c') : isDarkMode ? '#fbbf24' : '#b45309';
  const border = isDanger
    ? isDarkMode
      ? 'rgba(239, 68, 68, 0.5)'
      : 'rgba(220, 38, 38, 0.4)'
    : isDarkMode
      ? 'rgba(234, 179, 8, 0.5)'
      : 'rgba(202, 138, 4, 0.4)';
  const bg = isDanger
    ? isDarkMode
      ? 'rgba(80, 20, 20, 0.55)'
      : 'rgba(254, 226, 226, 0.85)'
    : isDarkMode
      ? 'rgba(80, 60, 15, 0.5)'
      : 'rgba(254, 249, 195, 0.9)';

  const headline = usage.overflowDetected
    ? `Context is full for ${modelName}`
    : isDanger
      ? `Context nearly full for ${modelName}`
      : `Context is filling up on ${modelName}`;

  return (
    <Box
      data-testid="session-context-usage-warning"
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 1.5,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: '8px',
        px: 1.5,
        py: 1,
        mb: 1,
        animation: `${fadeIn} 0.25s ease-out`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <WarningAmberRoundedIcon sx={{ fontSize: '20px', color: accent, mt: '1px', flexShrink: 0 }} />
        <Box>
          <Typography
            data-testid="context-usage-warning-text"
            sx={{ fontSize: '13px', fontWeight: 600, color: accent }}
          >
            {headline} - {used} of {max} tokens ({pct}%)
          </Typography>
          <Typography sx={{ fontSize: '12px', color: 'text.secondary', mt: 0.25 }}>
            {usage.overflowDetected
              ? 'The next turn may be rejected. Start a new notebook to reset, or the oldest turns will be dropped from context.'
              : 'As it fills, older turns get summarized or dropped and answers can lose detail. Consider starting a new notebook for a fresh topic.'}
            {usage.cachingIneffective
              ? ` This model applies no caching discount, so each turn re-bills the full context - long sessions cost more here.`
              : ''}
          </Typography>
        </Box>
      </Box>
      <IconButton
        data-testid="context-usage-warning-dismiss"
        size="sm"
        variant="plain"
        onClick={onDismiss}
        aria-label="Dismiss context warning"
        sx={{ color: accent, flexShrink: 0, minHeight: '24px', minWidth: '24px' }}
      >
        <CloseRoundedIcon sx={{ fontSize: '18px' }} />
      </IconButton>
    </Box>
  );
}
