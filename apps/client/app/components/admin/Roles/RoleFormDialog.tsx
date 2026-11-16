import { useState } from 'react';
import { Alert, Box, Button, Checkbox, FormControl, FormLabel, Input, Stack, Textarea, Typography } from '@mui/joy';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_DESCRIPTION_MAX_LENGTH,
  ADMIN_ROLE_NAME_MAX_LENGTH,
  ADMIN_ROLE_TEMPLATES,
  sortAdminPermissions,
  type AdminPermissionId,
  type AdminRoleTemplate,
} from '@bike4mind/common';
import { useCreateAdminRole, useUpdateAdminRole, type AdminRoleRow } from '@client/app/hooks/data/adminRoles';
import { getErrorMessage } from '@client/app/utils/error';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { ADMIN_REASON_PRESETS, ActionDialog, AdminDialog, ChangePreview, StatusChip } from '../shared';
import {
  diffPermissions,
  isSensitivePermission,
  permissionDescription,
  permissionLabel,
  permissionLabels,
  pluralUsers,
} from './roleModel';

type RoleFormDialogProps = { onClose: () => void } & (
  { mode: 'create'; role?: undefined } | { mode: 'edit' | 'view'; role: AdminRoleRow }
);

export function RoleFormDialog({ mode, role, onClose }: RoleFormDialogProps) {
  const readOnly = mode === 'view';
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<AdminPermissionId[]>(role?.permissions ?? []);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateAdminRole();
  const update = useUpdateAdminRole();

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameChanged = !!role && trimmedName !== role.name;
  const descriptionChanged = !!role && trimmedDescription !== role.description;
  const { granted, revoked } = diffPermissions(role?.permissions ?? [], permissions);
  const permissionsChanged = !!role && (granted.length > 0 || revoked.length > 0);
  // Edit-time guard only: a new role has no members, so a sensitive grant takes effect at role assignment, which gates separately.
  const sensitiveGranted = granted.filter(isSensitivePermission);

  const blocked =
    (!trimmedName && 'Name the role.') ||
    (permissions.length === 0 && 'Pick at least one permission.') ||
    (mode === 'edit' && !nameChanged && !descriptionChanged && !permissionsChanged && 'Change something to save.') ||
    null;

  const pickTemplate = (template: AdminRoleTemplate) => {
    setTemplateId(template.id);
    setName(template.name);
    setDescription(template.description);
    setPermissions(sortAdminPermissions(template.permissions));
  };

  const togglePermission = (id: AdminPermissionId) =>
    setPermissions(current =>
      sortAdminPermissions(current.includes(id) ? current.filter(each => each !== id) : [...current, id])
    );

  const fieldPatch = () => ({
    ...(nameChanged && { name: trimmedName }),
    ...(descriptionChanged && { description: trimmedDescription }),
  });

  const submit = async () => {
    if (blocked || readOnly) return;
    setError(null);
    if (mode === 'create') {
      try {
        await create.mutateAsync({ name: trimmedName, description: trimmedDescription, permissions });
        onClose();
      } catch (caught) {
        setError(getErrorMessage(caught));
      }
      return;
    }
    if (!role) return;
    if (permissionsChanged) {
      setAcknowledged(false);
      setReviewing(true);
      return;
    }
    try {
      await update.mutateAsync({ id: role.id, patch: fieldPatch() });
      onClose();
    } catch (caught) {
      if (!isStepUpCancelled(caught)) setError(getErrorMessage(caught));
    }
  };

  const closeReview = () => {
    setReviewing(false);
    setAcknowledged(false);
  };

  const confirmPermissionChange = async (reason: string) => {
    if (!role) return;
    setError(null);
    try {
      await update.mutateAsync({ id: role.id, patch: { ...fieldPatch(), permissions, reason } });
      onClose();
    } catch (caught) {
      if (!isStepUpCancelled(caught)) setError(getErrorMessage(caught));
    }
  };

  const title = mode === 'create' ? 'Create role' : mode === 'edit' ? 'Edit role' : (role?.name ?? 'Role');

  return (
    <>
      <AdminDialog title={title} onClose={onClose} width={680} data-testid="admin-role-form-dialog">
        <Stack
          gap={2}
          component="form"
          noValidate
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          {mode === 'create' && (
            <Stack gap={1} data-testid="admin-role-templates">
              <Typography level="title-md" sx={{ color: 'admin.ink' }}>
                Start from template
              </Typography>
              <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
                {ADMIN_ROLE_TEMPLATES.map(template => (
                  <Button
                    key={template.id}
                    type="button"
                    variant="outlined"
                    color="neutral"
                    aria-pressed={templateId === template.id}
                    onClick={() => pickTemplate(template)}
                    data-testid={`admin-role-template-${template.id}`}
                    sx={{
                      display: 'block',
                      height: 'auto',
                      p: 1.5,
                      textAlign: 'left',
                      whiteSpace: 'normal',
                      ...(templateId === template.id && {
                        bgcolor: 'admin.selection.background',
                        borderColor: 'admin.selection.border',
                      }),
                    }}
                  >
                    <Typography component="span" level="title-sm" sx={{ display: 'block', color: 'admin.ink' }}>
                      {template.name}
                    </Typography>
                    <Typography component="span" level="body-xs" sx={{ display: 'block', color: 'admin.inkMuted' }}>
                      {template.description}
                    </Typography>
                    <Typography
                      component="span"
                      level="body-xs"
                      sx={{ display: 'block', mt: 0.5, color: 'admin.inkSecondary' }}
                      data-testid={`admin-role-template-${template.id}-permissions`}
                    >
                      {permissionLabels(template.permissions)}
                    </Typography>
                  </Button>
                ))}
              </Box>
            </Stack>
          )}

          <FormControl required={!readOnly}>
            <FormLabel>Name</FormLabel>
            <Input
              value={name}
              onChange={event => setName(event.target.value)}
              readOnly={readOnly}
              slotProps={{ input: { maxLength: ADMIN_ROLE_NAME_MAX_LENGTH, 'data-testid': 'admin-role-name-input' } }}
            />
          </FormControl>
          <FormControl>
            <FormLabel>Description</FormLabel>
            <Textarea
              minRows={2}
              maxRows={4}
              value={description}
              onChange={event => setDescription(event.target.value)}
              readOnly={readOnly}
              slotProps={{
                textarea: {
                  maxLength: ADMIN_ROLE_DESCRIPTION_MAX_LENGTH,
                  'data-testid': 'admin-role-description-input',
                },
              }}
            />
          </FormControl>

          <Stack gap={1} role="group" aria-label="Permissions" data-testid="admin-role-permissions">
            <Typography level="title-md" sx={{ color: 'admin.ink' }}>
              Permissions
            </Typography>
            {ADMIN_PERMISSIONS.map(id => (
              <Checkbox
                key={id}
                checked={permissions.includes(id)}
                disabled={readOnly}
                onChange={() => togglePermission(id)}
                data-testid={`admin-role-permission-${id}`}
                label={
                  <Stack component="span" gap={0.25}>
                    <Stack component="span" direction="row" alignItems="center" gap={1}>
                      <Typography component="span" level="body-md" sx={{ color: 'admin.ink' }}>
                        {permissionLabel(id)}
                      </Typography>
                      {isSensitivePermission(id) && <StatusChip tone="neutral" label="Sensitive" />}
                    </Stack>
                    <Typography component="span" level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      {permissionDescription(id)}
                    </Typography>
                  </Stack>
                }
              />
            ))}
          </Stack>

          {error && !reviewing && (
            <Alert color="danger" data-testid="admin-role-form-error">
              {error}
            </Alert>
          )}

          <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1} flexWrap="wrap">
            {!readOnly && blocked && (
              <Typography
                level="body-sm"
                sx={{ mr: 'auto', color: 'admin.inkMuted' }}
                data-testid="admin-role-form-hint"
              >
                {blocked}
              </Typography>
            )}
            <Button
              type="button"
              variant="plain"
              color="neutral"
              onClick={onClose}
              data-testid="admin-role-form-cancel-btn"
            >
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {!readOnly && (
              <Button
                type="submit"
                disabled={!!blocked}
                loading={create.isPending || (update.isPending && !reviewing)}
                data-testid="admin-role-form-save-btn"
              >
                {mode === 'create' ? 'Create role' : permissionsChanged ? 'Review changes' : 'Save changes'}
              </Button>
            )}
          </Stack>
        </Stack>
      </AdminDialog>

      {reviewing && role && (
        <ActionDialog
          open
          onClose={closeReview}
          title="Change role permissions"
          description={`This changes access for ${pluralUsers(role.memberCount)}.`}
          reasonPresets={ADMIN_REASON_PRESETS.permissionsChange}
          confirmLabel="Save permissions"
          blockedReason={
            sensitiveGranted.length > 0 && !acknowledged ? 'Confirm the sensitive permissions to continue.' : null
          }
          pending={update.isPending}
          onConfirm={confirmPermissionChange}
          data-testid="admin-role-review-dialog"
        >
          <Stack gap={1.5}>
            <ChangePreview
              before={permissionLabels(role.permissions)}
              after={permissionLabels(permissions)}
              delta={{ label: `+${granted.length} / -${revoked.length}`, tone: 'neutral' }}
              data-testid="admin-role-review-preview"
            />
            {sensitiveGranted.length > 0 && (
              <Alert color="warning" data-testid="admin-role-sensitive-alert">
                <Checkbox
                  checked={acknowledged}
                  onChange={event => setAcknowledged(event.target.checked)}
                  data-testid="admin-role-sensitive-confirm"
                  label={`I understand this gives ${pluralUsers(role.memberCount)} ${permissionLabels(sensitiveGranted)}.`}
                />
              </Alert>
            )}
            {error && (
              <Alert color="danger" data-testid="admin-role-review-error">
                {error}
              </Alert>
            )}
          </Stack>
        </ActionDialog>
      )}
    </>
  );
}
