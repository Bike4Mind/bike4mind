import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import { ACCOUNT_DELETION_GRACE_DAYS } from '@bike4mind/common';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import { useRequestAccountDeletion } from '@client/app/hooks/data/user';
import { getErrorMessage } from '@client/app/utils/error';
import { TypedConfirmField, matchesConfirmWord } from './DeleteAllConfirmModals';

// Keep in sync with what DELETE /api/users/me does (apps/client/server/accountDeletion/requestAccountDeletion.ts).
const CONSEQUENCES =
  'You will be signed out on every device and any active subscription is canceled right away. ' +
  `Your account and all of its data are permanently deleted after ${ACCOUNT_DELETION_GRACE_DAYS} days. ` +
  'Until then you can sign in and restore it.';

function DeleteAccountConfirm({ onCancel }: { onCancel: () => void }) {
  const [typed, setTyped] = useState('');
  const requestDeletion = useRequestAccountDeletion();
  const pending = requestDeletion.isPending;

  return (
    <ConfirmActionModal
      data-testid="delete-account-confirm"
      title="Delete your account"
      description={`${CONSEQUENCES} Organizations you own that nobody else belongs to are deleted with it.`}
      forwardButtonText="Delete my account"
      onGoBackward={() => !pending && onCancel()}
      onGoForward={() => requestDeletion.mutate()}
      disabledConfirm={pending || !matchesConfirmWord(typed)}
      loading={pending}
    >
      <Stack spacing={1}>
        <TypedConfirmField value={typed} onChange={setTyped} disabled={pending} testId="delete-account-confirm-input" />
        {requestDeletion.isError && (
          <Typography level="body-sm" color="danger" data-testid="delete-account-confirm-error">
            {getErrorMessage(requestDeletion.error)}
          </Typography>
        )}
      </Stack>
    </ConfirmActionModal>
  );
}

/** Settings "Danger Zone": self-service account deletion with a grace period. */
export default function DeleteAccountSection() {
  const [confirming, setConfirming] = useState(false);

  return (
    <SectionContainer title="Danger Zone">
      <Box
        data-testid="delete-account-section"
        sx={theme => ({
          ...cardSurfaceSx(theme),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        })}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
            Delete account
          </Typography>
          <Typography level="body-sm" sx={{ mt: 0.5 }}>
            {CONSEQUENCES}
          </Typography>
        </Box>
        <Button
          color="danger"
          variant="outlined"
          onClick={() => setConfirming(true)}
          data-testid="delete-account-open-btn"
        >
          Delete account
        </Button>
      </Box>
      {confirming && <DeleteAccountConfirm onCancel={() => setConfirming(false)} />}
    </SectionContainer>
  );
}
