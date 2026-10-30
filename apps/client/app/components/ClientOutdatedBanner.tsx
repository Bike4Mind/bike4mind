'use client';

import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import { useClientOutdatedStore } from '@client/app/stores/useClientOutdatedStore';

/**
 * Shown once an API response reports a deploy this page load predates. Deliberately persistent and
 * not dismissible: the tab's bundle no longer matches the server, so the only useful action is a
 * reload.
 */
export const ClientOutdatedBanner = () => {
  const outdated = useClientOutdatedStore(state => state.outdated);

  if (!outdated) return null;

  // A Box, not Alert: spacing and glass styling are pinned to the marketing-site announcement pill.
  return (
    <Box
      role="status"
      data-testid="client-outdated-banner"
      sx={theme => ({
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        width: '100%',
        // Sized to the current label; recheck if the copy changes.
        maxWidth: 270,
        display: 'flex',
        alignItems: 'center',
        py: 0.5,
        px: 1.5,
        minHeight: 40,
        borderRadius: '12px',
        border: '1px solid rgba(var(--joy-palette-primary-mainChannel) / 0.6)',
        bgcolor: 'rgba(var(--joy-palette-primary-mainChannel) / 0.16)',
        backdropFilter: 'blur(16px)',
        color: 'text.primary',
        [theme.getColorSchemeSelector('dark')]: { color: 'common.white' },
        fontSize: 'sm',
      })}
    >
      <RefreshRounded sx={{ fontSize: 16, color: 'inherit', mr: 0.5 }} />
      <Box component="span" sx={{ flexGrow: 1, fontWeight: 'lg' }}>
        New version available
      </Box>
      <Button
        size="sm"
        color="primary"
        variant="solid"
        data-testid="client-outdated-reload-btn"
        onClick={() => window.location.reload()}
        sx={{ ml: 1.5, borderRadius: '8px', flexShrink: 0 }}
      >
        Reload
      </Button>
    </Box>
  );
};
