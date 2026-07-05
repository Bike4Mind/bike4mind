import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import { IUserDocument } from '@bike4mind/common';
import { Button, Checkbox, Input, Modal, ModalDialog, Stack, Tooltip, Typography } from '@mui/joy';
import React, { useState } from 'react';
import { toast } from 'sonner';
import DestructiveActionHelp from '@client/app/components/help/DestructiveActionHelp';

interface SpicyUserActionsProps {
  user: IUserDocument;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
  handleDeleteUser: (userId: string) => Promise<void>;
}

const SpicyUserActions: React.FC<SpicyUserActionsProps> = React.memo(
  ({ user, editedFields, onFieldChange, handleDeleteUser }) => {
    const [deleteInput, setDeleteInput] = useState('');
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

    const handleDeleteInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setDeleteInput(e.target.value);
    };

    const handleDeleteButton = () => {
      if (deleteInput.toUpperCase() === 'DELETE') {
        setIsConfirmOpen(true);
      } else {
        toast('Please type DELETE to confirm deletion');
      }
    };

    const confirmDelete = async () => {
      setIsDeleting(true);
      try {
        await handleDeleteUser(user.id);
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
            <Stack direction="row" spacing={2}>
              <Checkbox
                size="lg"
                variant="outlined"
                color={editedFields?.isBanned ? 'danger' : 'neutral'}
                checked={user.isBanned}
                onChange={handleBanChange}
                sx={{ paddingRight: 2 }}
              />
              Ban
            </Stack>
          </Tooltip>
          <DestructiveActionHelp
            consequences="Banning blocks this user from signing in. It does not delete their account or data, and you can unban them later."
            helpId="admin/user-management"
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title="Moderated Users Cannot use AI">
            <Stack direction="row" spacing={2}>
              <Checkbox
                size="lg"
                variant="outlined"
                color={editedFields?.isModerated ? 'danger' : 'neutral'}
                checked={user.isModerated}
                onChange={handleModerationChange}
                sx={{ paddingRight: 2 }}
              />
              Moderate
            </Stack>
          </Tooltip>
          <DestructiveActionHelp
            consequences="Moderated users can't use AI features, but can still sign in and access their data. You can remove moderation later."
            helpId="admin/user-management"
          />
        </Stack>
        <Stack direction="row" spacing={2}>
          <span>
            <Input
              data-testid="delete-user-confirm-input"
              size="sm"
              color={'danger'}
              type="text"
              placeholder="type DELETE"
              value={deleteInput}
              onChange={handleDeleteInputChange}
            />
          </span>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title={'Delete User, Cannot be Undone - Ban?'}>
            <Button
              disabled={deleteInput !== 'DELETE'}
              color="danger"
              variant="solid"
              onClick={handleDeleteButton}
              loading={isDeleting}
              data-testid="delete-user-btn"
            >
              Delete User
            </Button>
          </Tooltip>
          <DestructiveActionHelp
            consequences="Deleting permanently removes this user and all their data. This cannot be undone — consider Ban instead if you might need to restore access later."
            helpId="admin/user-management"
          />
        </Stack>
        <Modal open={isConfirmOpen} onClose={() => setIsConfirmOpen(false)}>
          <ModalDialog>
            <Typography level="h4">Confirm Delete</Typography>
            <Typography>Are you sure you want to delete this user? This action cannot be undone.</Typography>
            <Stack direction="row" spacing={2} justifyContent="flex-end">
              <Button onClick={() => setIsConfirmOpen(false)}>Cancel</Button>
              <Button color="danger" onClick={confirmDelete} loading={isDeleting} data-testid="confirm-delete-btn">
                Delete
              </Button>
            </Stack>
          </ModalDialog>
        </Modal>
      </Stack>
    );
  }
);

SpicyUserActions.displayName = 'SpicyUserActions';

export default SpicyUserActions;
