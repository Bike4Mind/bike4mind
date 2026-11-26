import React, { useState } from 'react';
import { Box, FormControl, FormLabel, Option, Select, Skeleton, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SETTINGS_PAGE_READ, meetsAdminPermissionRequirement, type UserOAuthClientRolesView } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import {
  assignUserOAuthClientRole,
  fetchUserOAuthClientRoles,
  unassignUserOAuthClientRole,
} from '@client/app/utils/oauthClientAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  EmptyState,
  ErrorState,
  RelativeTime,
  SectionCard,
  StatusChip,
} from '../../../shared';
import { adminActionBlockedReason, displayName, type AdminUserProfile } from '../userProfileModel';
import { HeaderAction, RowAction } from './cardActions';

export const USER_OAUTH_CLIENT_ROLES_QUERY_KEY = 'admin-user-oauth-client-roles';

type HeldRole = {
  clientId: string;
  clientName: string;
  isActive: boolean;
  role: string;
  label: string;
  assignedAt: string;
};

const heldRoles = (clients: readonly UserOAuthClientRolesView[]): HeldRole[] =>
  clients.flatMap(client =>
    client.assigned.map(a => ({
      clientId: client.clientId,
      clientName: client.clientName,
      isActive: client.isActive,
      role: a.role,
      label: a.label,
      assignedAt: a.assignedAt,
    }))
  );

/** The roles of `client` the user does not hold yet. */
const assignableRoles = (client: UserOAuthClientRolesView) =>
  client.roles.filter(role => !client.assigned.some(a => a.role === role.key));

const AssignRoleDialog: React.FC<{
  user: AdminUserProfile;
  clients: readonly UserOAuthClientRolesView[];
  onClose: () => void;
  onDone: () => void;
}> = ({ user, clients, onClose, onDone }) => {
  const [clientId, setClientId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (reason: string) =>
      assignUserOAuthClientRole(user.id, { clientId: clientId as string, role: role as string, reason }),
  });
  const offering = clients.filter(c => assignableRoles(c).length > 0);
  const client = offering.find(c => c.clientId === clientId);
  const roleLabel = client?.roles.find(r => r.key === role)?.label;

  const confirm = async (reason: string) => {
    try {
      await mutation.mutateAsync(reason);
      onDone();
      toast.success(`${displayName(user)} now has ${roleLabel} on ${(client as UserOAuthClientRolesView).clientName}.`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Assign app role"
      description={`The app will be able to read this role for ${displayName(user)} once role claims are enabled. Other apps, and other stages of the same app, will not see it.`}
      reasonPresets={ADMIN_REASON_PRESETS.oauthClientRoleAssign}
      confirmLabel={roleLabel ? `Assign ${roleLabel}` : 'Assign role'}
      blockedReason={!client ? 'Pick an app.' : !roleLabel ? 'Pick a role.' : null}
      pending={mutation.isPending}
      onConfirm={confirm}
      data-testid="user-oauth-role-assign-dialog"
    >
      <Stack spacing={1.5}>
        <FormControl required>
          <FormLabel>App</FormLabel>
          <Select
            value={clientId}
            onChange={(_e, value) => {
              setClientId(value);
              setRole(null);
            }}
            placeholder="Pick an app"
            data-testid="user-oauth-role-client-select"
          >
            {offering.map(c => (
              <Option key={c.clientId} value={c.clientId} data-testid={`user-oauth-role-client-option-${c.clientId}`}>
                {`${c.clientName} (${c.clientId})`}
              </Option>
            ))}
          </Select>
        </FormControl>
        <FormControl required disabled={!client}>
          <FormLabel>Role</FormLabel>
          <Select
            value={role}
            onChange={(_e, value) => setRole(value)}
            placeholder="Pick a role"
            data-testid="user-oauth-role-role-select"
          >
            {(client ? assignableRoles(client) : []).map(r => (
              <Option key={r.key} value={r.key} data-testid={`user-oauth-role-role-option-${r.key}`}>
                {`${r.label} (${r.key})`}
              </Option>
            ))}
          </Select>
        </FormControl>
      </Stack>
    </ActionDialog>
  );
};

const RemoveRoleDialog: React.FC<{
  user: AdminUserProfile;
  held: HeldRole;
  onClose: () => void;
  onDone: () => void;
}> = ({ user, held, onClose, onDone }) => {
  const mutation = useMutation({
    mutationFn: (reason: string) =>
      unassignUserOAuthClientRole(user.id, { clientId: held.clientId, role: held.role, reason }),
  });

  const confirm = async (reason: string) => {
    try {
      await mutation.mutateAsync(reason);
      onDone();
      toast.success(`Removed ${held.label} on ${held.clientName} from ${displayName(user)}.`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Remove app role"
      description={`${displayName(user)} will no longer hold ${held.label} on ${held.clientName}.`}
      reasonPresets={ADMIN_REASON_PRESETS.oauthClientRoleUnassign}
      tone="danger"
      confirmLabel={`Remove ${held.label}`}
      pending={mutation.isPending}
      onConfirm={confirm}
      data-testid="user-oauth-role-remove-dialog"
    />
  );
};

/**
 * The roles the user holds on each OAuth client (per-app roles: an app only reads its own). Assigning
 * and removing needs settings:manage, like managing the clients themselves, and a full admin for an
 * account with admin access (the server's assertCanActOnAdminTarget).
 */
export const OAuthClientRolesCard: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const { currentUser } = useUser();
  const canRead = meetsAdminPermissionRequirement(currentUser, SETTINGS_PAGE_READ);
  const canManage = adminActionBlockedReason(currentUser, user, 'settings:manage') === null;
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ kind: 'assign' } | { kind: 'remove'; held: HeldRole } | null>(null);
  const query = useQuery({
    queryKey: [USER_OAUTH_CLIENT_ROLES_QUERY_KEY, user.id],
    queryFn: () => fetchUserOAuthClientRoles(user.id),
    enabled: canRead,
  });
  const clients = query.data ?? [];
  const held = heldRoles(clients);
  const canAssign = canManage && clients.some(c => assignableRoles(c).length > 0);

  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    void queryClient.invalidateQueries({ queryKey: [USER_OAUTH_CLIENT_ROLES_QUERY_KEY, user.id] });
  };

  const body = () => {
    if (query.isPending) {
      return (
        <Stack gap={1.5} sx={{ p: 2 }} data-testid="user-oauth-roles-loading">
          <Skeleton variant="text" level="body-sm" width="60%" />
        </Stack>
      );
    }
    if (query.isError) {
      return <ErrorState message="App roles could not be loaded." onRetry={() => void query.refetch()} />;
    }
    if (held.length === 0) {
      return (
        <Box data-testid="user-oauth-roles-empty">
          <EmptyState
            title="No app roles"
            description={clients.length ? undefined : 'No OAuth client offers roles yet.'}
            action={null}
          />
        </Box>
      );
    }
    return (
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }} data-testid="user-oauth-roles-list">
        {held.map(h => (
          <Stack
            key={`${h.clientId}:${h.role}`}
            component="li"
            direction="row"
            alignItems="center"
            gap={0.75}
            flexWrap="wrap"
            sx={{ px: 2, py: 1.25, '& + &': { borderTop: '1px solid', borderColor: 'admin.border' } }}
            data-testid={`user-oauth-role-${h.clientId}-${h.role}`}
          >
            <Typography level="body-sm" fontWeight="lg" title={h.clientId}>
              {h.clientName}
            </Typography>
            <StatusChip tone="neutral" label={h.label} />
            {!h.isActive && (
              <StatusChip tone="warn" label="App inactive" data-testid={`user-oauth-role-${h.clientId}-inactive`} />
            )}
            <RelativeTime prefix="Assigned" at={new Date(h.assignedAt)} />
            {canManage && (
              <Box sx={{ ml: 'auto' }}>
                <RowAction
                  onClick={() => setDialog({ kind: 'remove', held: h })}
                  data-testid={`user-oauth-role-${h.clientId}-${h.role}-remove-btn`}
                >
                  Remove
                </RowAction>
              </Box>
            )}
          </Stack>
        ))}
      </Box>
    );
  };

  if (!canRead) return null;

  return (
    <>
      <SectionCard
        title="App roles"
        body="custom"
        action={
          canAssign ? (
            <HeaderAction onClick={() => setDialog({ kind: 'assign' })} data-testid="user-oauth-role-assign-btn">
              Assign role
            </HeaderAction>
          ) : undefined
        }
        data-testid="user-oauth-roles-card"
      >
        {body()}
      </SectionCard>
      {dialog?.kind === 'assign' && <AssignRoleDialog user={user} clients={clients} onClose={close} onDone={done} />}
      {dialog?.kind === 'remove' && <RemoveRoleDialog user={user} held={dialog.held} onClose={close} onDone={done} />}
    </>
  );
};
