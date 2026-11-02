import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Box, Button, Container, Sheet, Stack, Typography } from '@mui/joy';
import { accountDeletionDueAt } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useRestoreAccountDeletion, useUserLogout } from '@client/app/hooks/data/user';
import { getErrorMessage } from '@client/app/utils/error';

/**
 * Shown to a signed-in account that is scheduled for deletion: the router guard (consentGuard.ts) sends
 * every other page here, and the server's deletionPendingGate refuses everything but restore and sign-out.
 */
const AccountDeletionPage = () => {
  const navigate = useNavigate();
  const { currentUser } = useUser();
  const accessToken = useAccessToken(s => s.accessToken);
  const restore = useRestoreAccountDeletion();
  const logout = useUserLogout();
  const deletionRequestedAt = currentUser?.deletionRequestedAt;

  useEffect(() => {
    if (!accessToken) {
      void navigate({ to: '/login', replace: true });
    } else if (currentUser && !deletionRequestedAt) {
      void navigate({ to: '/', replace: true });
    }
  }, [accessToken, currentUser, deletionRequestedAt, navigate]);

  if (!deletionRequestedAt) return null;
  const busy = restore.isPending || logout.isPending;

  return (
    <Box
      sx={theme => ({
        backgroundColor: theme.palette.background.surface,
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
      })}
    >
      <Container maxWidth="sm">
        <Sheet
          variant="outlined"
          sx={{ p: 4, borderRadius: 'lg', boxShadow: 'lg' }}
          data-testid="account-deletion-page"
        >
          <Stack spacing={3}>
            <Typography level="h3" sx={{ textAlign: 'center' }}>
              Your account is scheduled for deletion
            </Typography>
            <Typography level="body-md" sx={{ color: 'text.secondary' }}>
              It will be permanently deleted on{' '}
              <strong data-testid="account-deletion-scheduled-for">
                {accountDeletionDueAt(deletionRequestedAt).toLocaleDateString(undefined, { dateStyle: 'long' })}
              </strong>
              , together with all of its data. Restore it to keep using it. Subscriptions canceled by the deletion
              request stay canceled.
            </Typography>
            {restore.isError && (
              <Typography level="body-sm" color="danger" data-testid="account-deletion-restore-error">
                {getErrorMessage(restore.error)}
              </Typography>
            )}
            <Stack direction="row" spacing={1.5} justifyContent="flex-end">
              <Button
                variant="plain"
                color="neutral"
                disabled={busy}
                onClick={() => logout.mutate()}
                data-testid="account-deletion-signout-btn"
              >
                Sign out
              </Button>
              <Button
                loading={restore.isPending}
                disabled={busy}
                onClick={() =>
                  restore.mutate(undefined, { onSuccess: () => void navigate({ to: '/', replace: true }) })
                }
                data-testid="account-deletion-restore-btn"
              >
                Restore my account
              </Button>
            </Stack>
          </Stack>
        </Sheet>
      </Container>
    </Box>
  );
};

export default AccountDeletionPage;
