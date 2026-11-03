import React, { useState } from 'react';
import { Box, Link, Skeleton, Stack, Typography } from '@mui/joy';
import { isFullAdmin, organizationMemberRole } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserOrganizations } from '@client/app/hooks/data/organizations';
import { EmptyState, ErrorState, SectionCard, StatusChip } from '../../../shared';
import { adminOrganizationHref } from '../../../organizationsTabSearch';
import {
  AddToOrganizationDialog,
  ChangeOrgRoleDialog,
  RemoveFromOrganizationDialog,
  type MembershipOrg,
} from '../actions/orgMembershipDialogs';
import {
  ORGANIZATION_ROLE_LABELS,
  activeOrganizationId,
  organizationName,
  type AdminUserProfile,
} from '../userProfileModel';
import { HeaderAction, RowAction } from './cardActions';

type OpenDialog = { kind: 'add' } | { kind: 'remove' | 'role'; org: MembershipOrg } | null;

const OrgLink: React.FC<{ id: string; name: string }> = ({ id, name }) => (
  <Link
    href={adminOrganizationHref(id)}
    sx={{ color: 'admin.link', fontWeight: 500, overflowWrap: 'anywhere' }}
    data-testid={`user-profile-org-${id}-link`}
  >
    {name}
  </Link>
);

/**
 * Every org the user owns, manages or belongs to, from the org documents (`user.organizationId` is
 * only the active-org pointer). Listing another user's orgs needs full admin, since
 * GET /api/organizations scopes everyone else to their own.
 */
export const OrganizationsCard: React.FC<{ user: AdminUserProfile; onAudit?: () => void }> = ({ user, onAudit }) => {
  const { currentUser } = useUser();
  const canManage = isFullAdmin(currentUser);
  // Another admin, or the user leaving, can change membership while this card is unmounted.
  const orgs = useGetUserOrganizations(canManage ? user.id : null, { refetchOnMount: 'always' });
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const activeId = activeOrganizationId(user);
  const list = orgs.data ?? [];

  const addButton = (
    <HeaderAction onClick={() => setDialog({ kind: 'add' })} data-testid="user-profile-org-add-btn">
      Add to organization
    </HeaderAction>
  );

  const body = () => {
    if (!canManage) {
      const activeName = organizationName(user);
      return (
        <Stack gap={0.5} sx={{ p: 2 }}>
          {activeId && activeName && <OrgLink id={activeId} name={activeName} />}
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Full administrators can see and change every organization this account is in.
          </Typography>
        </Stack>
      );
    }
    if (orgs.isLoading) {
      return (
        <Stack gap={1.5} sx={{ p: 2 }} data-testid="user-profile-orgs-loading">
          <Skeleton variant="text" level="body-sm" width="60%" />
          <Skeleton variant="text" level="body-sm" width="45%" />
        </Stack>
      );
    }
    if (orgs.isError && !orgs.data) {
      return <ErrorState message="Organizations could not be loaded." onRetry={() => void orgs.refetch()} />;
    }
    if (list.length === 0) return <EmptyState title="Not in any organization" action={addButton} />;
    return (
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }} data-testid="user-profile-orgs-list">
        {list.map(org => {
          const role = organizationMemberRole(org, user.id) ?? 'member';
          return (
            <Stack
              key={org.id}
              component="li"
              direction="row"
              alignItems="center"
              gap={0.75}
              flexWrap="wrap"
              sx={{ px: 2, py: 1.25, '& + &': { borderTop: '1px solid', borderColor: 'admin.border' } }}
              data-testid={`user-profile-org-${org.id}-row`}
            >
              <OrgLink id={org.id} name={org.name} />
              <StatusChip
                tone={role === 'owner' ? 'info' : 'neutral'}
                label={ORGANIZATION_ROLE_LABELS[role]}
                data-testid={`user-profile-org-${org.id}-role`}
              />
              {org.id === activeId && (
                <StatusChip tone="good" dot label="Active" data-testid={`user-profile-org-${org.id}-active`} />
              )}
              <Stack direction="row" gap={0.25} sx={{ ml: 'auto' }}>
                <RowAction
                  onClick={() => setDialog({ kind: 'role', org })}
                  data-testid={`user-profile-org-${org.id}-role-btn`}
                >
                  Change role
                </RowAction>
                <RowAction
                  onClick={() => setDialog({ kind: 'remove', org })}
                  data-testid={`user-profile-org-${org.id}-remove-btn`}
                >
                  Remove
                </RowAction>
              </Stack>
            </Stack>
          );
        })}
      </Box>
    );
  };

  const close = () => setDialog(null);

  return (
    <>
      <SectionCard
        title="Organizations"
        body="custom"
        action={canManage && list.length > 0 ? addButton : undefined}
        data-testid="user-profile-orgs-card"
      >
        {body()}
      </SectionCard>
      {dialog?.kind === 'add' && (
        <AddToOrganizationDialog user={user} memberOrgIds={list.map(org => org.id)} onClose={close} onAudit={onAudit} />
      )}
      {dialog?.kind === 'role' && (
        <ChangeOrgRoleDialog user={user} org={dialog.org} onClose={close} onAudit={onAudit} />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveFromOrganizationDialog
          user={user}
          org={dialog.org}
          isActive={dialog.org.id === activeId}
          onClose={close}
        />
      )}
    </>
  );
};
