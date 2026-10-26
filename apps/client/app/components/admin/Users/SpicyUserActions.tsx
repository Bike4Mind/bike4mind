import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { AdminFieldKey, EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import type { ThrottleTier } from '@bike4mind/common';
import { Button, Checkbox, Input, Stack, Tooltip, Typography } from '@mui/joy';
import React, { useState } from 'react';
import { toast } from 'sonner';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from '@client/app/components/admin/shared/adminReason';
import DestructiveActionHelp from '@client/app/components/help/DestructiveActionHelp';

interface SpicyUserActionsProps {
  user: AdminUserListItem & { throttleTier?: ThrottleTier; throttleReason?: string };
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: AdminFieldKey, value: unknown) => void;
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

    const shadowed = (user.throttleTier ?? user.throttle?.tier ?? 'none') === 'shadow';

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
        <Stack direction="column" spacing={1}>
          <Tooltip title="Applies lower limits and a cheaper model without telling the user">
            <Checkbox
              size="lg"
              variant="outlined"
              color={editedFields?.throttleTier ? 'warning' : 'neutral'}
              checked={shadowed}
              onChange={e => onFieldChange('throttleTier', e.target.checked ? 'shadow' : 'none')}
              label="Shadow tier"
              data-testid="admin-user-shadow-checkbox"
            />
          </Tooltip>
          {editedFields?.throttleTier && (
            <Input
              size="sm"
              placeholder="Reason (required)"
              value={user.throttleReason ?? ''}
              onChange={e => onFieldChange('throttleReason', e.target.value)}
              data-testid="admin-user-shadow-reason-input"
            />
          )}
          {!!(user.throttle || user.riskSignals?.length) && (
            <Typography level="body-xs" data-testid="admin-user-shadow-info">
              {user.throttle &&
                `Tier ${user.throttle.tier}, source ${user.throttle.source}, changed ${String(user.throttle.changedAt).slice(0, 10)}. `}
              {user.riskSignals?.length
                ? `Signals: ${user.riskSignals.map(sig => `${sig.type} (${String(sig.at).slice(0, 10)})`).join(', ')}`
                : ''}
            </Typography>
          )}
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
