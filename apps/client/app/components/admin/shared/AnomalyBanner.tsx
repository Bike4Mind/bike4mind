import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { adminFocusScope } from './adminStyles';

// The banner is one dark strip in both color schemes, as the list's one loud element.
const BANNER = { background: '#18181B', foreground: '#FAFAFA', muted: '#C4C4CC', tile: '#3A2A12', warn: '#FBBF24' };

export type AnomalyBannerProps = {
  headline: string;
  detail?: string;
  actionLabel: string;
  onAction: () => void;
  /** Dismissing hides the banner for this key only: a new key (the next scan window, a new count) shows it again. */
  dismissKey: string;
  testId?: string;
  actionTestId?: string;
  dismissTestId?: string;
};

/** The one loud strip a list page shows when something needs review. The caller decides when to render it. */
export function AnomalyBanner({
  headline,
  detail,
  actionLabel,
  onAction,
  dismissKey,
  testId = 'anomaly-banner',
  actionTestId = 'anomaly-banner-action-btn',
  dismissTestId = 'anomaly-banner-dismiss-btn',
}: AnomalyBannerProps) {
  const [dismissedKey, setDismissedKey] = useState<string>();
  if (dismissedKey === dismissKey) return null;
  return (
    <Stack
      role="status"
      direction={{ xs: 'column', sm: 'row' }}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      gap={1.5}
      data-testid={testId}
      sx={{
        ...adminFocusScope,
        px: 2,
        py: 1.5,
        borderRadius: '12px',
        bgcolor: BANNER.background,
        color: BANNER.foreground,
        border: '1px solid',
        borderColor: 'admin.border',
      }}
    >
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ flex: 1, minWidth: 0 }}>
        <Box
          aria-hidden
          sx={{
            width: 32,
            height: 32,
            borderRadius: '8px',
            bgcolor: BANNER.tile,
            color: BANNER.warn,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <WarningAmberIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ color: BANNER.foreground, fontSize: 13, fontWeight: 600 }}>{headline}</Typography>
          {detail && <Typography sx={{ color: BANNER.muted, fontSize: 12 }}>{detail}</Typography>}
        </Box>
      </Stack>
      <Stack direction="row" gap={1} sx={{ flexShrink: 0 }}>
        <Button
          size="sm"
          data-testid={actionTestId}
          onClick={onAction}
          sx={{
            minHeight: 32,
            bgcolor: BANNER.foreground,
            color: BANNER.background,
            '&:hover': { bgcolor: '#E4E4E7' },
            '&:focus-visible': { outline: `2px solid ${BANNER.warn} !important`, outlineOffset: 2 },
          }}
        >
          {actionLabel}
        </Button>
        <Button
          size="sm"
          variant="plain"
          data-testid={dismissTestId}
          onClick={() => setDismissedKey(dismissKey)}
          sx={{
            minHeight: 32,
            color: BANNER.muted,
            '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.08)', color: BANNER.foreground },
            '&:focus-visible': { outline: `2px solid ${BANNER.warn} !important`, outlineOffset: 2 },
          }}
        >
          Dismiss
        </Button>
      </Stack>
    </Stack>
  );
}
