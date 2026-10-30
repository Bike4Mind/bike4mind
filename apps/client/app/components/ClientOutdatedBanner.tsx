'use client';

import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import { useClientOutdatedStore } from '@client/app/stores/useClientOutdatedStore';

/**
 * Shown once an API response reports a deploy this page load predates. Deliberately persistent and
 * not dismissible: the tab's bundle no longer matches the server, so the only useful action is a
 * reload.
 */
export const ClientOutdatedBanner = () => {
  const outdated = useClientOutdatedStore(state => state.outdated);

  if (!outdated) return null;

  return (
    <Alert
      color="warning"
      data-testid="client-outdated-banner"
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10000,
        borderRadius: 0,
        justifyContent: 'center',
        gap: 2,
      }}
    >
      A new version of the app is available. Reload to continue.
      <Button
        size="sm"
        color="warning"
        variant="solid"
        data-testid="client-outdated-reload-btn"
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
    </Alert>
  );
};
