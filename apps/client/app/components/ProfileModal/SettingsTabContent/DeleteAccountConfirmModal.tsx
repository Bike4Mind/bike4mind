import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FormControl, FormLabel, Input, Link, List, ListItem, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { ACCOUNT_DELETION_GRACE_DAYS } from '@bike4mind/common';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { formatScheduledDeletionDate } from '@client/app/components/auth/AccountDeletionPendingGate';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccountDeletionStatus, useRequestAccountDeletion } from '@client/app/hooks/data/accountDeletion';
import { getErrorMessage } from '@client/app/utils/error';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';

const DAY_MS = 24 * 60 * 60 * 1000;

const normalizeEmail = (value: string) => value.trim().toLowerCase();

// The scope copy below describes what POST /api/account/deletion does
// (apps/client/server/users/accountDeletion.ts) - keep in sync.
export function DeleteAccountConfirm({ onCancel }: { onCancel: () => void }) {
  const email = useUser(s => s.currentUser?.email) ?? '';
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  // Fixed at open, so the stated date does not drift across re-renders.
  const [purgeAt] = useState(() => new Date(Date.now() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS));
  const { data: status, isLoading } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const pending = requestDeletion.isPending;
  const ownedOrganizations = status?.ownedOrganizations ?? [];

  if (ownedOrganizations.length > 0) {
    return (
      <ConfirmActionModal
        data-testid="delete-account-org-owner"
        title="Delete account"
        description={
          'You own the organizations below. Transfer ownership of each one or delete it before deleting your ' +
          'account, so its members and billing are not left without an owner.'
        }
        forwardButtonText="Delete account"
        onGoBackward={onCancel}
        onGoForward={() => undefined}
        disabledConfirm
      >
        <List data-testid="delete-account-owned-orgs" sx={{ '--ListItem-paddingX': 0 }}>
          {ownedOrganizations.map(org => (
            <ListItem key={org.id}>
              <Link
                component="button"
                onClick={() => {
                  onCancel();
                  navigate({ to: '/organizations/$id', params: { id: org.id } });
                }}
                data-testid="delete-account-org-link"
              >
                {org.name}
              </Link>
            </ListItem>
          ))}
        </List>
      </ConfirmActionModal>
    );
  }

  const purgeDate = formatScheduledDeletionDate(purgeAt);
  const matches = !!email && normalizeEmail(typed) === normalizeEmail(email);

  return (
    <ConfirmActionModal
      data-testid="delete-account-confirm"
      title="Delete account"
      description={
        'You will be signed out on every device right away, your API keys and connected apps will be revoked, ' +
        'your subscriptions will be canceled, and the pages and Skill Market listings you published will be taken ' +
        `offline. Your account will be permanently deleted on ${purgeDate}. Until then you can sign ` +
        'in and cancel the deletion; canceling restores access, but not what was revoked or taken offline. ' +
        'To keep a copy of your data, use Download your data before you continue.'
      }
      forwardButtonText="Delete account"
      onGoBackward={() => !pending && onCancel()}
      onGoForward={() =>
        requestDeletion.mutate(undefined, {
          onError: error => {
            if (!isStepUpCancelled(error)) toast.error(getErrorMessage(error));
          },
        })
      }
      loading={pending}
      disabledConfirm={isLoading || pending || !matches}
    >
      <FormControl>
        <FormLabel>
          Type your email
          {email ? (
            <Typography component="span" sx={{ fontWeight: 'lg', ml: 0.5 }}>
              {email}
            </Typography>
          ) : null}{' '}
          to confirm
        </FormLabel>
        <Input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          disabled={pending}
          autoComplete="off"
          autoFocus
          slotProps={{
            input: {
              'data-testid': 'delete-account-confirm-input',
              spellCheck: false,
              autoCapitalize: 'none',
              autoCorrect: 'off',
            },
          }}
        />
      </FormControl>
    </ConfirmActionModal>
  );
}
