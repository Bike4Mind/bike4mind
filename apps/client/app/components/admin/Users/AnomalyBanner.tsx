import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { SignupAnomalySnapshot } from '@client/app/utils/signupAnomaly';
import { adminFocusScope } from '../shared/adminStyles';

// The banner is one dark strip in both color schemes, as the list's one loud element.
const BANNER = { background: '#18181B', foreground: '#FAFAFA', muted: '#C4C4CC', tile: '#3A2A12', warn: '#FBBF24' };

function headline(snapshot: SignupAnomalySnapshot): string {
  if (snapshot.signupSpike) {
    const domain = snapshot.topDomain ? `, mostly @${snapshot.topDomain}` : '';
    return `Signup spike: ${snapshot.signupCount.toLocaleString()} new accounts in the last hour${domain}`;
  }
  if (snapshot.apiKeySpike) return `API key spike: ${snapshot.apiKeyCount.toLocaleString()} new keys in the last hour`;
  return 'Signup scan limit reached';
}

/**
 * Shown only while the last hour looks abnormal. Dismissing hides it for this snapshot window only:
 * the next scan that still flags a spike shows it again.
 */
export function AnomalyBanner({ snapshot, onReview }: { snapshot?: SignupAnomalySnapshot; onReview: () => void }) {
  const [dismissedWindow, setDismissedWindow] = useState<string>();
  if (!snapshot || (!snapshot.signupSpike && !snapshot.apiKeySpike && !snapshot.truncated)) return null;
  if (dismissedWindow === snapshot.since) return null;
  return (
    <Stack
      role="status"
      direction={{ xs: 'column', sm: 'row' }}
      alignItems={{ xs: 'stretch', sm: 'center' }}
      gap={1.5}
      data-testid="users-anomaly-banner"
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
          <Typography sx={{ color: BANNER.foreground, fontSize: 13, fontWeight: 600 }}>{headline(snapshot)}</Typography>
          <Typography sx={{ color: BANNER.muted, fontSize: 12 }}>
            {snapshot.signupCount.toLocaleString()} signups and {snapshot.apiKeyCount.toLocaleString()} new API keys in
            the last hour.
            {snapshot.truncated && ' Scan limit reached; counts and domain ranking are partial.'}
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" gap={1} sx={{ flexShrink: 0 }}>
        <Button
          size="sm"
          data-testid="users-review-cluster-btn"
          onClick={onReview}
          sx={{
            minHeight: 32,
            bgcolor: BANNER.foreground,
            color: BANNER.background,
            '&:hover': { bgcolor: '#E4E4E7' },
            '&:focus-visible': { outline: `2px solid ${BANNER.warn} !important`, outlineOffset: 2 },
          }}
        >
          Review cluster
        </Button>
        <Button
          size="sm"
          variant="plain"
          data-testid="users-dismiss-anomaly-btn"
          onClick={() => setDismissedWindow(snapshot.since)}
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
