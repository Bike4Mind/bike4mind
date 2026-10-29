import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useUser } from '@client/app/contexts/UserContext';
import { useReturnToAdmin } from '@client/app/hooks/data/user';
import { api } from '@client/app/contexts/apiClient';
import { ActionDialog } from './admin/shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from './admin/shared/adminReason';

function tokenDeadline(token: string | null): number | null {
  try {
    const payload = JSON.parse(atob((token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      impersonationExpiresAt?: unknown;
    };
    return typeof payload.impersonationExpiresAt === 'number' && Number.isFinite(payload.impersonationExpiresAt)
      ? payload.impersonationExpiresAt
      : null;
  } catch {
    return null;
  }
}

export function ImpersonationBanner() {
  const impersonating = useAccessToken(s => s.impersonating);
  const token = useAccessToken(s => s.accessToken);
  const { currentUser } = useUser();
  const end = useReturnToAdmin();
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState('');
  const attempted = useRef(false);
  const state = useQuery({
    queryKey: ['impersonation', token],
    enabled: impersonating && !!token,
    queryFn: async () => (await api.get<{ expiresAt: string; writeEnabled: boolean }>('/api/auth/impersonation')).data,
    staleTime: 15_000,
  });
  const deadline = state.data ? new Date(state.data.expiresAt).getTime() : tokenDeadline(token);
  const remaining = deadline === null ? null : Math.max(0, deadline - now);
  useEffect(() => {
    if (!impersonating) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const focus = () => setNow(Date.now());
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [impersonating]);
  useEffect(() => {
    if (remaining !== 0 || attempted.current) return;
    attempted.current = true;
    end.mutate();
  }, [remaining, end]);
  if (!impersonating) return null;
  return (
    <>
      <Alert
        role="region"
        aria-label="Support access session"
        data-testid="impersonation-banner"
        color="warning"
        sx={{ borderRadius: 0, flexWrap: 'wrap', flexShrink: 0 }}
      >
        <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1} sx={{ width: '100%' }}>
          <Typography level="title-sm">
            Viewing as {currentUser?.name || currentUser?.email || currentUser?.username || 'user'}
          </Typography>
          <Typography level="body-sm">
            {state.data?.writeEnabled ? 'Changes allowed' : 'Read-only'}
            {remaining !== null ? ` - ${Math.ceil(remaining / 60_000)} min remaining` : ''}
          </Typography>
          {!state.data?.writeEnabled && (
            <Button
              variant="outlined"
              color="neutral"
              disabled={!state.data || remaining === 0}
              data-testid="impersonation-allow-btn"
              onClick={() => setDialog(true)}
            >
              Allow changes
            </Button>
          )}
          <Button
            color="neutral"
            loading={end.isPending}
            onClick={() => end.mutate()}
            data-testid="impersonation-end-btn"
          >
            End
          </Button>
          {(error || end.isError) && (
            <Typography role="alert">{error || 'Could not end support access. Try End again.'}</Typography>
          )}
        </Stack>
      </Alert>
      {dialog && (
        <ActionDialog
          open
          onClose={() => setDialog(false)}
          title="Allow changes"
          confirmLabel="Allow changes"
          description="Allows notebook, message and file edits for the remaining support session. Identity, credentials, billing, account deletion, agent changes, integrations and automated tool execution stay blocked."
          reasonPresets={ADMIN_REASON_PRESETS.impersonation}
          data-testid="impersonation-escalate-dialog"
          onConfirm={async reason => {
            try {
              await api.post('/api/auth/impersonation', { reason });
              await state.refetch();
              setDialog(false);
              setError('');
            } catch (cause) {
              setError('Could not allow changes. Try again.');
              throw cause;
            }
          }}
        />
      )}
    </>
  );
}
