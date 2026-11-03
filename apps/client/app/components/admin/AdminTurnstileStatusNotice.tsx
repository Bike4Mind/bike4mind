import React from 'react';
import { Alert } from '@mui/joy';
import { useConfig } from '@client/app/hooks/data/settings';

export const AdminTurnstileStatusNotice: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { data } = useConfig();
  if (!enabled || data?.turnstileSecretConfigured !== false) return null;

  return (
    <Alert color="warning" variant="soft" data-testid="admin-turnstile-secret-missing-alert">
      Turnstile is on, but no Turnstile secret key is provisioned on this server, so the challenge is skipped. Set
      TURNSTILE_SECRET_KEY and redeploy or restart.
    </Alert>
  );
};
