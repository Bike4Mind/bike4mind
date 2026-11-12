import {
  ASSIGNABLE_ORG_ROLES,
  AssignableOrgRole,
  InviteType,
  IUserDocument,
  Permission,
  IOrganizationDocument,
  canAssignOrgRole,
  orgAclRowConfersMembership,
  organizationMemberRole,
} from '@bike4mind/common';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useCancelInvite } from '@client/app/hooks/data/invites';
import { getAppFileUrl } from '@client/app/utils/s3';
import { Box, Avatar, Stack, IconButton, Dropdown, MenuButton, Menu, MenuItem, Chip, Typography } from '@mui/joy';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { FC, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useLeaveOrganization,
  useSetMemberCreditOverride,
  useSetOrganizationMemberRole,
} from '@client/app/hooks/data/organizations';
import { useNavigate } from '@tanstack/react-router';
import CreditLimitModal from './CreditLimitModal';
import OffboardMemberDialog from './OffboardMemberDialog';
import { formatMemberCredits, formatMemberCreditUsage, MemberCreditUsage } from './memberCreditBudget';

interface OrganizationUserCardProps {
  organization: IOrganizationDocument;
  /** `creditUsage` is null for a pending invite, which has no budget yet. */
  user: IUserDocument & {
    status: 'accepted' | 'pending';
    permissions: Permission[];
    creditUsage: MemberCreditUsage | null;
  };
  /** Viewer may cancel a pending invite (`isOrgMember` and `manageMembers`, the invite routes' gates). */
  canInviteMembers: boolean;
  /** Viewer may revoke a member (`canRevokeOrgMember`, the DELETE member route's gate). */
  canRevokeMembers: boolean;
  /** Viewer may set this member's monthly credit limit (`canManageMemberCreditBudgets`). */
  canManageCreditBudgets: boolean;
}

const OrganizationUserCard: FC<OrganizationUserCardProps> = ({
  organization,
  user,
  canInviteMembers,
  canRevokeMembers,
  canManageCreditBudgets,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { currentUser } = useUser();
  const { id: organizationId } = organization;
  const queryClient = useQueryClient();
  const avatarUrl = user.photoUrl ? getAppFileUrl({ key: user.photoUrl }) : '';
  const { mutateAsync: cancelInvite } = useCancelInvite({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', organizationId, 'pending'] });
      queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'invites'] });
      toast.success('Invite cancelled successfully');
    },
    onError: err => {
      toast.error(err.message);
    },
  });
  const isOwner = user?.id === organization.userId;
  const memberRole = organizationMemberRole(organization, user.id);
  const { mutateAsync: leaveOrganization } = useLeaveOrganization();

  const confirm = useConfirmation();
  const chips = (
    <Stack direction="row" spacing={1}>
      {user.isBanned && (
        <Chip size="sm" variant="soft" color="danger">
          Deactivated
        </Chip>
      )}
      {user.status === 'pending' ? (
        <Chip size="sm" variant="soft" color="warning">
          Pending
        </Chip>
      ) : isOwner ? (
        <Chip size="sm" variant="soft" color="primary" data-testid="organization-user-card-owner-chip">
          {t('organization.roles.owner')}
        </Chip>
      ) : memberRole === 'manager' ? (
        <Chip size="sm" variant="soft" color="success" data-testid="organization-user-card-manager-chip">
          {t('organization.roles.manager')}
        </Chip>
      ) : memberRole === 'billingManager' ? (
        <Chip size="sm" variant="outlined" color="success" data-testid="organization-user-card-billing-manager-chip">
          {t('organization.roles.billingManager')}
        </Chip>
      ) : (
        <>
          <Chip size="sm" variant="soft" data-testid="organization-user-card-member-chip">
            {t('organization.roles.member')}
          </Chip>
          {/* Not a role: share/update on the ACL row opens the Settings tab (canManageOrg in
              routes/organizations/$id.tsx), so the owner needs to see who holds it. */}
          {user.permissions.some(p => p === Permission.share || p === Permission.update) && (
            <Chip size="sm" variant="outlined" data-testid="organization-user-card-settings-access-chip">
              {t('organization.access.can_edit_settings')}
            </Chip>
          )}
        </>
      )}
    </Stack>
  );
  const [offboarding, setOffboarding] = useState(false);
  const handleRemoveMember = useCallback(() => setOffboarding(true), []);

  const handleLeaveOrganization = useCallback(async () => {
    confirm({
      title: 'Leave Team',
      description: 'Are you sure you want to leave this team?',
      type: 'danger',
      onOk: async () => {
        await leaveOrganization({ organizationId });
        navigate({ to: '/organizations' });
      },
    });
  }, [confirm, organizationId, leaveOrganization, navigate]);

  const canRevoke = canRevokeMembers && user.status === 'accepted';
  const canLeave = user.status === 'accepted' && currentUser?.id === user.id;
  const canCancelInvite = user.status === 'pending' && canInviteMembers;
  // Roles above Member need an active member row (setOrganizationMemberRole); moving to Member is
  // always allowed so a deactivated manager can still be demoted.
  const isAssignableRole = (role: AssignableOrgRole) =>
    user.status === 'accepted' &&
    canAssignOrgRole(currentUser ?? { id: '' }, organization, user.id, role) &&
    (role === 'member' || (!user.isBanned && orgAclRowConfersMembership(user)));
  const selectableRoles = ASSIGNABLE_ORG_ROLES.filter(role => role !== memberRole && isAssignableRole(role));
  const canChangeRole = !isOwner && !organization.personal && selectableRoles.length > 0;
  // The owner row is excluded from roster actions but not from budgets: the owner's own spend from
  // the pool is capped like anyone's.
  const hasRosterAction = !isOwner && (canRevoke || canLeave || canCancelInvite);
  const setRole = useSetOrganizationMemberRole();
  const canSetCreditLimit = canManageCreditBudgets && user.status === 'accepted';

  const [editingLimit, setEditingLimit] = useState(false);
  const setOverride = useSetMemberCreditOverride();
  const creditUsage = user.creditUsage;
  const creditUsageLabel = creditUsage ? formatMemberCreditUsage(creditUsage) : '-';
  const creditUsageCell = (
    <Typography
      level="body-sm"
      component="span"
      sx={{ color: creditUsage?.tracked ? 'text.primary' : 'text.tertiary', whiteSpace: 'nowrap' }}
      data-testid="organization-user-card-credit-usage"
    >
      {creditUsageLabel}
      {creditUsage?.isOverride && (
        <Typography level="body-xs" component="span" sx={{ color: 'text.tertiary', ml: 0.5 }}>
          (own limit)
        </Typography>
      )}
    </Typography>
  );

  const roleSelect = canChangeRole && (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="outlined"
        endDecorator={<ArrowDropDownIcon />}
        loading={setRole.isPending}
        data-testid="organization-user-card-role-select"
      >
        {t('organization.roles.label')}
      </MenuButton>
      <Menu placement="bottom-end" sx={{ zIndex: 9999 }}>
        {ASSIGNABLE_ORG_ROLES.filter(role => role === memberRole || selectableRoles.includes(role)).map(role => (
          <MenuItem
            key={role}
            selected={role === memberRole}
            disabled={setRole.isPending || role === memberRole}
            onClick={() => setRole.mutate({ organizationId, userId: user.id, role })}
            data-testid={`organization-user-card-role-option-${role}`}
          >
            {t(`organization.roles.${role}`)}
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );

  const actionsMenu = (hasRosterAction || canSetCreditLimit) && (
    <Dropdown>
      <MenuButton
        className="organization-user-card-menu-button"
        data-testid="org-user-card-menu-btn"
        slots={{ root: IconButton }}
        slotProps={{ root: { variant: 'outlined', size: 'sm' } }}
      >
        <MoreVertIcon />
      </MenuButton>
      <Menu placement="bottom-end" sx={{ zIndex: 9999 }}>
        {canSetCreditLimit && (
          <MenuItem onClick={() => setEditingLimit(true)} data-testid="organization-user-card-set-limit">
            Set monthly limit
          </MenuItem>
        )}
        {!isOwner && canCancelInvite && (
          <MenuItem
            onClick={() =>
              confirm({
                title: 'Cancel Invite',
                description: 'Are you sure you want to cancel this invite?',
                type: 'danger',
                onOk: () =>
                  cancelInvite({
                    id: organizationId,
                    type: InviteType.Organization,
                    // By id: the pending-users list carries no address for non-admins, and a cancel
                    // naming nobody would cancel every open invite to the organization.
                    userId: user.id,
                  }),
              })
            }
            data-testid="organization-user-card-cancel-invite"
          >
            Cancel Invite
          </MenuItem>
        )}
        {!isOwner && canRevoke && (
          <MenuItem onClick={handleRemoveMember} data-testid="organization-user-card-revoke-access">
            Revoke Access
          </MenuItem>
        )}
        {!isOwner && canLeave && (
          <MenuItem onClick={handleLeaveOrganization} data-testid="organization-user-card-leave">
            Leave Team
          </MenuItem>
        )}
      </Menu>
    </Dropdown>
  );

  const offboardDialog = canRevoke && (
    <OffboardMemberDialog
      organizationId={organizationId}
      member={offboarding ? { id: user.id, name: user.name } : null}
      onClose={() => setOffboarding(false)}
    />
  );

  const creditLimitModal = canSetCreditLimit && (
    <CreditLimitModal
      open={editingLimit}
      onClose={() => setEditingLimit(false)}
      title={`Monthly credit limit for ${user.name}`}
      description={
        organization.maxCreditsPerMember == null
          ? 'Overrides the team default, which is currently no limit.'
          : `Overrides the team default of ${formatMemberCredits(organization.maxCreditsPerMember)} credits per month.`
      }
      currentValue={creditUsage?.isOverride ? creditUsage.cap : null}
      allowZero
      clearLabel="Use team default"
      saving={setOverride.isPending}
      onSave={maxCredits => setOverride.mutateAsync({ organizationId, userId: user.id, maxCredits })}
    />
  );

  if (isMobile) {
    return (
      <Box
        className="organization-user-card-container"
        data-testid="organization-user-card"
        data-user-id={user.id}
        sx={theme => ({
          borderRadius: '8px',
          border: '1px solid',
          borderColor: 'divider',
          backgroundColor: theme.palette.primary.softBg,
          padding: '10px 12px',
        })}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            <Avatar className="organization-user-card-avatar" size="sm" variant="soft" src={avatarUrl}>
              {user.name?.charAt(0).toUpperCase()}
            </Avatar>
            <Stack sx={{ minWidth: 0 }}>
              <Box
                className="organization-user-card-name"
                sx={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {user.name}
              </Box>
              <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                {chips}
                {creditUsageCell}
              </Stack>
            </Stack>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            {roleSelect}
            {actionsMenu}
          </Stack>
        </Stack>
        {creditLimitModal}
        {offboardDialog}
      </Box>
    );
  }

  return (
    <Box
      className="organization-user-card-container"
      data-testid="organization-user-card"
      data-user-id={user.id}
      sx={theme => ({
        borderRadius: '8px',
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr',
        width: '100%',
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: theme.palette.primary.softBg,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 15px',
        position: 'relative',
      })}
    >
      <Box
        className="organization-user-card-user-info"
        display="flex"
        alignItems={'center'}
        sx={{ justifyContent: 'space-between' }}
        gap="10px"
        zIndex={2}
      >
        <Stack className="organization-user-card-user-stack" direction="row" spacing={2} alignItems="center">
          <Avatar className="organization-user-card-avatar" size="sm" variant="soft" src={avatarUrl}>
            {user.name?.charAt(0).toUpperCase()}
          </Avatar>
          <Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Box className="organization-user-card-name">{user.name}</Box>
              {chips}
            </Stack>
          </Stack>
        </Stack>
      </Box>

      <Box className="organization-user-card-credits" display="flex" justifyContent="center" alignItems="center">
        {creditUsageCell}
      </Box>
      <Box className="organization-user-card-actions" display="flex" gap="10px" justifyContent="flex-end" zIndex={2}>
        {roleSelect}
        {actionsMenu}
      </Box>
      {creditLimitModal}
      {offboardDialog}
    </Box>
  );
};

export default OrganizationUserCard;
