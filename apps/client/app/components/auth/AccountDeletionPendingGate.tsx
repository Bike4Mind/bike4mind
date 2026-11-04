import React, { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { useUserLogout } from '@client/app/hooks/data/user';
import { useCancelAccountDeletion } from '@client/app/hooks/data/accountDeletion';
import { registerAccountDeletionInterceptor } from '@client/app/utils/accountDeletionInterceptor';
import { getErrorMessage } from '@client/app/utils/error';

export const formatScheduledDeletionDate = (value: Date | string | undefined | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { dateStyle: 'long' });
};

/**
 * While the signed-in account is scheduled for deletion, renders only the cancel screen in place of
 * the app: the server refuses every other route then (deletionPendingGate), so nothing that fetches
 * app data may mount. Keyed on the user's `deletion` and on any deletion-pending 403.
 *
 * `exempt` renders the children anyway, for a page that only calls routes the server gate still
 * allows (the data export download page).
 */
const AccountDeletionPendingGate: React.FC<{ children: React.ReactNode; exempt?: boolean }> = ({
  children,
  exempt = false,
}) => {
  const deletion = useUser(s => s.currentUser?.deletion);
  const [refusedScheduledFor, setRefusedScheduledFor] = useState<string | null>(null);
  const cancelDeletion = useCancelAccountDeletion();
  const { mutate: logout, isPending: logoutIsPending } = useUserLogout();

  useEffect(() => registerAccountDeletionInterceptor(api, setRefusedScheduledFor), []);

  if (exempt || (!deletion && refusedScheduledFor === null)) return <>{children}</>;

  const date = formatScheduledDeletionDate(deletion?.scheduledFor ?? refusedScheduledFor);

  return (
    <Box
      data-testid="account-deletion-pending-screen"
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        flexDirection: 'column',
        gap: 3,
        px: 2,
        textAlign: 'center',
      }}
    >
      <Typography level="h2">Your account is scheduled for deletion</Typography>
      <Typography level="body-md" sx={{ maxWidth: 520, color: 'text.secondary' }} data-testid="account-deletion-date">
        {date
          ? `Your account will be permanently deleted on ${date}.`
          : 'Your account will be permanently deleted soon.'}{' '}
        Cancel the deletion to use your account again.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Button
          data-testid="account-deletion-cancel-btn"
          loading={cancelDeletion.isPending}
          onClick={() => cancelDeletion.mutate(undefined, { onError: error => toast.error(getErrorMessage(error)) })}
        >
          Cancel deletion
        </Button>
        <Button
          data-testid="account-deletion-sign-out-btn"
          variant="outlined"
          color="neutral"
          loading={logoutIsPending}
          onClick={() => logout(undefined, { onError: () => toast.error("Couldn't sign out. Please try again.") })}
        >
          Sign out
        </Button>
      </Box>
    </Box>
  );
};

export default AccountDeletionPendingGate;
