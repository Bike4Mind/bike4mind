import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import { IUserDocument } from '@bike4mind/common';
import { Button, Checkbox, Stack, Tooltip } from '@mui/joy';
import React, { useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from '@client/app/components/admin/shared/adminReason';
import DestructiveActionHelp from '@client/app/components/help/DestructiveActionHelp';

interface SpicyUserActionsProps {
  user: AdminUserListItem;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
  handleDeleteUser: (userId: string, reason: string) => Promise<void>;
}

const SpicyUserActions: React.FC<SpicyUserActionsProps> = React.memo(
  ({ user, editedFields, onFieldChange, handleDeleteUser }) => {
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const handleBanChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.checked;
      onFieldChange('isBanned', newValue);
    };

    const handleModerationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.checked;
      onFieldChange('isModerated', newValue);
    };

    const confirmDelete = async (reason: string) => {
      setIsDeleting(true);
      try {
        await handleDeleteUser(user.id, reason);
        setIsConfirmOpen(false);
      } catch (error) {
        console.error('Failed to delete user:', error);
        toast.error('Failed to delete user');
      } finally {
        setIsDeleting(false);
      }
    };

    return (
      <Stack direction="column" spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title="Ban User, Does Not Delete">
            <Checkbox
              size="lg"
              variant="outlined"
              color={editedFields?.isBanned ? 'danger' : 'neutral'}
              checked={user.isBanned}
              onChange={handleBanChange}
              label="Ban"
              sx={{ paddingRight: 2 }}
            />
          </Tooltip>
          <DestructiveActionHelp
            consequences="Banning blocks this user from signing in. It does not delete their account or data, and you can unban them later."
            helpId="admin/user-management"
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title="Moderated Users Cannot use AI">
            <Checkbox
              size="lg"
              variant="outlined"
              color={editedFields?.isModerated ? 'danger' : 'neutral'}
              checked={user.isModerated}
              onChange={handleModerationChange}
              label="Moderate"
              sx={{ paddingRight: 2 }}
            />
          </Tooltip>
          <DestructiveActionHelp
            consequences="Moderated users can't use AI features, but can still sign in and access their data. You can remove moderation later."
            helpId="admin/user-management"
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            color="danger"
            variant="outlined"
            onClick={() => setIsConfirmOpen(true)}
            data-testid="delete-user-btn"
          >
            Delete user
          </Button>
          <DestructiveActionHelp
            consequences="Deleting permanently removes this user and all their data. This cannot be undone — consider Ban instead if you might need to restore access later."
            helpId="admin/user-management"
          />
        </Stack>
        <ActionDialog
          open={isConfirmOpen}
          onClose={() => setIsConfirmOpen(false)}
          title="Delete user"
          description="Permanently removes this user and all their data. Ban them instead if you might need to restore access."
          reasonPresets={ADMIN_REASON_PRESETS.userDeletion}
          typedConfirm={
            user.email ? { expected: user.email, noun: 'email address' } : { expected: user.id, noun: 'user ID' }
          }
          confirmLabel="Delete user permanently"
          tone="danger"
          pending={isDeleting}
          onConfirm={confirmDelete}
          data-testid="delete-user-dialog"
          testIds={{
            reason: 'user-delete-reason-input',
            confirm: 'confirm-delete-btn',
            typed: 'delete-user-confirm-input',
          }}
        />
      </Stack>
    );
  }
);

SpicyUserActions.displayName = 'SpicyUserActions';

export default SpicyUserActions;
