import { Box, IconButton, Typography, useTheme } from '@mui/joy';
import { keyframes } from '@mui/system';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { formatTokenCount, type SessionContextUsage } from '@client/app/hooks/useSessionContextUsage';

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
`;

/**
 * An attachment on THIS turn that will not survive the model's budget, measured before sending.
 * `measured` distinguishes a real extraction from a byte-size estimate, which is only a fair proxy for
 * plain text - so the copy can hedge rather than state a guess as fact.
 */
export interface AttachmentFitWarning {
  fileName: string;
  /** Whole percent of the file's text that will reach the model, 0-99. */
  deliveredPercent: number;
  measured: 'extracted' | 'fileSize';
  siblingCount: number;
}

/**
 * Two distinct warnings share this banner because they occupy the same slot above the composer and the
 * user reads them the same way. They are a discriminated union rather than one shape: an attachment
 * warning has no session utilization to report, and synthesizing usage numbers for it would put figures
 * on screen that describe nothing.
 */
type ContextUsageWarningProps = {
  show: boolean;
  modelName: string;
  onDismiss: () => void;
} & ({ usage: SessionContextUsage; attachment?: never } | { attachment: AttachmentFitWarning; usage?: never });

/**
 * Slim, non-blocking banner shown above the composer when a session's assembled
 * context approaches the model's ceiling, or when an attachment on this turn cannot
 * fit it. Unlike the credit warnings this does NOT cover the input - the user must be
 * able to keep typing while it shows.
 */
export function ContextUsageWarning({ show, usage, attachment, modelName, onDismiss }: ContextUsageWarningProps) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';

  if (!show) return null;

  if (attachment) {
    return (
      <AttachmentBanner attachment={attachment} modelName={modelName} onDismiss={onDismiss} isDarkMode={isDarkMode} />
    );
  }
  if (!usage) return null;

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

function AttachmentBanner({
  attachment,
  modelName,
  onDismiss,
  isDarkMode,
}: {
  attachment: AttachmentFitWarning;
  modelName: string;
  onDismiss: () => void;
  isDarkMode: boolean;
}) {
  const accent = isDarkMode ? '#fca5a5' : '#b91c1c';
  const border = isDarkMode ? 'rgba(239, 68, 68, 0.5)' : 'rgba(220, 38, 38, 0.4)';
  const bg = isDarkMode ? 'rgba(80, 20, 20, 0.55)' : 'rgba(254, 226, 226, 0.85)';

  // Hedged when the figure came from byte size, since that only tracks text length for plain text.
  const about = attachment.measured === 'extracted' ? 'about' : 'roughly';
  // Naming the sibling count matters: the budget is divided across attachments, so the fix is often
  // "send fewer files" rather than "pick another model".
  const because =
    attachment.siblingCount > 0
      ? `Its budget is shared with ${attachment.siblingCount} other attachment${attachment.siblingCount > 1 ? 's' : ''}, so sending fewer files at once will help.`
      : 'Switch to a model with a larger context window, or split the file.';

  return (
    <Box
      data-testid="attachment-fit-warning"
      // Announced, unlike the session meter beside it: this one's entire purpose is to reach the user
      // BEFORE they send, and a warning a screen reader never speaks does not do that. 'polite' rather
      // than 'assertive' so it waits for a pause instead of interrupting mid-compose.
      role="status"
      aria-live="polite"
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
            data-testid="attachment-fit-warning-text"
            sx={{ fontSize: '13px', fontWeight: 600, color: accent }}
          >
            {`"${attachment.fileName}" is too large for ${modelName} - ${about} ${attachment.deliveredPercent}% of it will reach the model`}
          </Typography>
          <Typography sx={{ fontSize: '12px', color: 'text.secondary', mt: 0.25 }}>
            {`The rest is cut before sending, and the model is told the file was shortened. ${because}`}
          </Typography>
        </Box>
      </Box>
      <IconButton
        data-testid="attachment-fit-warning-dismiss"
        size="sm"
        variant="plain"
        onClick={onDismiss}
        aria-label="Dismiss attachment warning"
        sx={{ color: accent, flexShrink: 0, minHeight: '24px', minWidth: '24px' }}
      >
        <CloseRoundedIcon sx={{ fontSize: '18px' }} />
      </IconButton>
    </Box>
  );
}
