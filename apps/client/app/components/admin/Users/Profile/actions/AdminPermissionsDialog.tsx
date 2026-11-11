import React, { useState } from 'react';
import { Checkbox, Stack, Typography } from '@mui/joy';
import { ADMIN_PERMISSIONS, sortAdminPermissions, type AdminPermissionId } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { ActionDialog, ADMIN_REASON_PRESETS, undoAdminReason, useUndoToast } from '../../../shared';
import { useAdminUserPermissionsUpdate } from './useAdminUserPermissionsUpdate';
import type { ProfileDialogProps } from './profileActions';
import { ADMIN_PERMISSION_LABELS, displayName } from '../userProfileModel';

const describeSet = (ids: readonly AdminPermissionId[]) =>
  ids.length ? ids.map(id => ADMIN_PERMISSION_LABELS[id].label).join(', ') : 'none';

/**
 * Delegated admin permissions only. Super Admin is a role and stays in Change role; the server
 * refuses self-changes and any edit to a Super Admin.
 */
export const AdminPermissionsDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const { currentUser } = useUser();
  const update = useAdminUserPermissionsUpdate(user.id);
  const showUndo = useUndoToast();
  const [before] = useState(() => sortAdminPermissions(user.adminPermissions ?? []));
  const [selected, setSelected] = useState<AdminPermissionId[]>(before);
  const unchanged = selected.length === before.length && selected.every(id => before.includes(id));
  const isSelf = currentUser?.id === user.id;

  const toggle = (id: AdminPermissionId, checked: boolean) =>
    setSelected(previous => sortAdminPermissions(checked ? [...previous, id] : previous.filter(item => item !== id)));

  const handleConfirm = async (reason: string) => {
    const saved = await update({ before, adminPermissions: selected, reason });
    onClose();
    showUndo({
      message: 'Admin permissions updated',
      onUndo: async () => {
        await update({ before: saved, adminPermissions: before, reason: undoAdminReason(reason) });
      },
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Edit admin permissions"
      description={`Delegated access for ${displayName(user)}. Each permission opens part of the admin area without making them a Super Admin.`}
      reasonPresets={ADMIN_REASON_PRESETS.permissionsChange}
      confirmLabel="Save permissions"
      tone="danger"
      blockedReason={
        isSelf
          ? 'You cannot change your own admin permissions.'
          : user.isAdmin
            ? 'Super Admins hold every permission. Change their role to limit their access.'
            : unchanged
              ? 'Grant or revoke a permission first.'
              : null
      }
      onConfirm={handleConfirm}
      data-testid="admin-permissions-dialog"
    >
      <Stack gap={1.25} data-testid="admin-permissions-dialog-list">
        {ADMIN_PERMISSIONS.map(id => (
          <Checkbox
            key={id}
            checked={selected.includes(id)}
            disabled={isSelf || !!user.isAdmin}
            onChange={event => toggle(id, event.target.checked)}
            label={
              <Stack>
                <Typography level="body-sm" fontWeight="md">
                  {ADMIN_PERMISSION_LABELS[id].label}
                </Typography>
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  {ADMIN_PERMISSION_LABELS[id].description}
                </Typography>
              </Stack>
            }
            data-testid={`admin-permissions-dialog-${id.replace(':', '-')}-checkbox`}
          />
        ))}
      </Stack>
      {!unchanged && (
        <Typography level="body-xs" data-testid="admin-permissions-dialog-preview">
          {describeSet(before)} {'\u2192'} {describeSet(selected)}
        </Typography>
      )}
    </ActionDialog>
  );
};
