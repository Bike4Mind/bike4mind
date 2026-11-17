import React, { useState } from 'react';
import { Checkbox, Stack, Typography } from '@mui/joy';
import { ADMIN_PERMISSIONS, sortAdminPermissions, sortAdminRoleIds, type AdminPermissionId } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { ActionDialog, ADMIN_REASON_PRESETS, undoAdminReason, useUndoToast } from '../../../shared';
import { useAdminRoleList, type AdminRoleListItem } from '../../useAdminRoleList';
import { useAdminUserPermissionsUpdate } from './useAdminUserPermissionsUpdate';
import type { ProfileDialogProps } from './profileActions';
import { ADMIN_PERMISSION_LABELS, displayName } from '../userProfileModel';
import { describeProvenance, permissionProvenance, roleGrantBlockedReason } from '../adminAccessModel';

const describeSet = (ids: readonly AdminPermissionId[]) =>
  ids.length ? ids.map(id => ADMIN_PERMISSION_LABELS[id].label).join(', ') : 'none';

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every(id => right.includes(id));

const testIdOf = (value: string) => value.replace(':', '-');

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
    {children}
  </Typography>
);

/**
 * Delegated admin access: the roles a user holds plus direct grants for one-off exceptions. Super
 * Admin is a role and stays in Change role; the server refuses self-changes and any edit to a Super Admin.
 */
export const AdminPermissionsDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const { currentUser } = useUser();
  const update = useAdminUserPermissionsUpdate(user.id);
  const showUndo = useUndoToast();
  const rolesQuery = useAdminRoleList();
  const roles: readonly AdminRoleListItem[] = rolesQuery.data ?? [];
  // Roles travel only once the list has loaded, so a failed list read still lets direct grants save.
  const rolesReady = rolesQuery.isSuccess;

  const [before] = useState(() => sortAdminPermissions(user.adminPermissions ?? []));
  const [beforeRoleIds] = useState(() => sortAdminRoleIds(user.adminRoleIds ?? []));
  const [selected, setSelected] = useState<AdminPermissionId[]>(before);
  // Starts from the roles that still exist: an id with no role grants nothing and the server refuses to keep it.
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[] | null>(null);
  const knownBeforeRoleIds = beforeRoleIds.filter(id => roles.some(role => role.id.toLowerCase() === id));
  const roleIds = selectedRoleIds ?? knownBeforeRoleIds;

  const rolesUnchanged = !rolesReady || sameSet(roleIds, beforeRoleIds);
  const unchanged = sameSet(selected, before) && rolesUnchanged;
  const isSelf = currentUser?.id === user.id;
  const locked = isSelf || !!user.isAdmin;
  const effective = permissionProvenance(selected, roleIds, roles);

  const toggle = (id: AdminPermissionId, checked: boolean) =>
    setSelected(previous => sortAdminPermissions(checked ? [...previous, id] : previous.filter(item => item !== id)));
  const toggleRole = (id: string, checked: boolean) =>
    setSelectedRoleIds(sortAdminRoleIds(checked ? [...roleIds, id] : roleIds.filter(item => item !== id)));

  const handleConfirm = async (reason: string) => {
    const roleChange = rolesReady ? { beforeAdminRoleIds: beforeRoleIds, adminRoleIds: roleIds } : {};
    const saved = await update({ before, adminPermissions: selected, ...roleChange, reason });
    onClose();
    showUndo({
      message: 'Admin access updated',
      onUndo: async () => {
        await update({
          before: saved.adminPermissions,
          adminPermissions: before,
          ...(rolesReady && { beforeAdminRoleIds: saved.adminRoleIds, adminRoleIds: beforeRoleIds }),
          reason: undoAdminReason(reason),
        });
      },
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Edit admin access"
      description={`Delegated access for ${displayName(user)}. Roles and direct permissions each open part of the admin area without making them a Super Admin.`}
      reasonPresets={ADMIN_REASON_PRESETS.permissionsChange}
      confirmLabel="Save access"
      tone="danger"
      blockedReason={
        isSelf
          ? 'You cannot change your own admin permissions.'
          : user.isAdmin
            ? 'Super Admins hold every permission. Change their role to limit their access.'
            : unchanged
              ? 'Change a role or permission first.'
              : null
      }
      onConfirm={handleConfirm}
      data-testid="admin-permissions-dialog"
    >
      <Stack gap={1.25} data-testid="admin-permissions-dialog-roles">
        <SectionLabel>Roles</SectionLabel>
        {rolesQuery.isLoading ? (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            Loading roles...
          </Typography>
        ) : rolesQuery.isError || !rolesReady ? (
          <Typography
            level="body-xs"
            sx={{ color: 'admin.inkMuted' }}
            data-testid="admin-permissions-dialog-roles-unavailable"
          >
            Roles could not be loaded. Role assignments stay as they are.
          </Typography>
        ) : roles.length === 0 ? (
          <Typography
            level="body-xs"
            sx={{ color: 'admin.inkMuted' }}
            data-testid="admin-permissions-dialog-roles-empty"
          >
            No roles yet. Create one on the Roles page.
          </Typography>
        ) : (
          roles.map(role => {
            const id = role.id.toLowerCase();
            const checked = roleIds.includes(id);
            // Removing a held role never grants anything, so only adding is gated.
            const blocked = checked ? null : roleGrantBlockedReason(currentUser, role);
            return (
              <Checkbox
                key={id}
                checked={checked}
                disabled={locked || !!blocked}
                onChange={event => toggleRole(id, event.target.checked)}
                label={
                  <Stack>
                    <Typography level="body-sm" fontWeight="md">
                      {role.name}
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      {describeSet(role.permissions)}
                    </Typography>
                    {blocked && (
                      <Typography
                        level="body-xs"
                        sx={{ color: 'admin.inkMuted' }}
                        data-testid={`admin-permissions-dialog-role-${id}-blocked`}
                      >
                        {blocked}
                      </Typography>
                    )}
                  </Stack>
                }
                data-testid={`admin-permissions-dialog-role-${id}-checkbox`}
              />
            );
          })
        )}
      </Stack>
      <Stack gap={1.25} data-testid="admin-permissions-dialog-list">
        <SectionLabel>Direct permissions</SectionLabel>
        {ADMIN_PERMISSIONS.map(id => (
          <Checkbox
            key={id}
            checked={selected.includes(id)}
            disabled={locked}
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
            data-testid={`admin-permissions-dialog-${testIdOf(id)}-checkbox`}
          />
        ))}
      </Stack>
      <Stack gap={0.5} data-testid="admin-permissions-dialog-effective">
        <SectionLabel>Effective permissions</SectionLabel>
        {effective.length === 0 ? (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            None
          </Typography>
        ) : (
          effective.map(entry => (
            <Typography
              key={entry.id}
              level="body-xs"
              data-testid={`admin-permissions-dialog-effective-${testIdOf(entry.id)}`}
            >
              {ADMIN_PERMISSION_LABELS[entry.id].label}{' '}
              <Typography component="span" sx={{ color: 'admin.inkMuted' }}>
                ({describeProvenance(entry)})
              </Typography>
            </Typography>
          ))
        )}
      </Stack>
      {!sameSet(selected, before) && (
        <Typography level="body-xs" data-testid="admin-permissions-dialog-preview">
          Direct: {describeSet(before)} {'\u2192'} {describeSet(selected)}
        </Typography>
      )}
    </ActionDialog>
  );
};
