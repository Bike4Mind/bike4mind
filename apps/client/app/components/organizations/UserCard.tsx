import {
  InviteType,
  IUserDocument,
  Permission,
  IOrganizationDocument,
  orgAclRowConfersMembership,
} from '@bike4mind/common';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useCancelInvite } from '@client/app/hooks/data/invites';
import { getAppFileUrl } from '@client/app/utils/s3';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import {
  Box,
  Avatar,
  Stack,
  IconButton,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
  Chip,
  Typography,
  Checkbox,
  ListDivider,
  Tooltip,
} from '@mui/joy';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { FC, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useRemoveMemberFromOrganization,
  useLeaveOrganization,
  useSetMemberCreditOverride,
  useSetOrganizationManager,
} from '@client/app/hooks/data/organizations';
import { useNavigate } from '@tanstack/react-router';
import { formatAccountAge, formatLastActiveTitle } from '@client/app/components/admin/Users/formatAccountAge';
import CreditLimitModal from './CreditLimitModal';
import { formatMemberCredits, formatMemberCreditUsage } from './memberCreditBudget';
import { REMOVE_MEMBER_EFFECT, RosterMember, rosterGridColumns } from './memberRosterView';

/** A roster row: the safe user shape plus its org standing. `creditUsage` is null for a pending invite. */
export type OrganizationRosterRow = IUserDocument & RosterMember & { permissions: Permission[] };

interface OrganizationUserCardProps {
  organization: IOrganizationDocument;
  user: OrganizationRosterRow;
  /** Viewer may cancel a pending invite (`isOrgMember` and `isOrgOwnerOrCurrentAdmin`, the invite routes' gates). */
  canInviteMembers: boolean;
  /** Viewer may revoke a member (`canRevokeOrgMember`, the DELETE member route's gate). */
  canRevokeMembers: boolean;
  /** Viewer may set this member's monthly credit limit (`canManageMemberCreditBudgets`). */
  canManageCreditBudgets: boolean;
  /** Viewer may make or remove managers (`isOrgOwnerOrPlatformAdmin`, the manager route's gate). */
  canManageManagers: boolean;
  /** The roster has a selection column; must match the header's `rosterGridColumns` argument. */
  selectable?: boolean;
  selected?: boolean;
  /** Absent when this row cannot be bulk-removed: its selection cell stays empty. */
  onToggleSelect?: () => void;
}

const ExplainedDash: FC<{ explanation: string; testId: string }> = ({ explanation, testId }) => (
  <Tooltip title={explanation} size="sm">
    <Typography level="body-sm" component="span" sx={{ color: 'text.tertiary' }} data-testid={testId} tabIndex={0}>
      <span aria-hidden="true">-</span>
      <Box component="span" sx={visuallyHidden}>
        {explanation}
      </Box>
    </Typography>
  </Tooltip>
);

const OrganizationUserCard: FC<OrganizationUserCardProps> = ({
  organization,
  user,
  canInviteMembers,
  canRevokeMembers,
  canManageCreditBudgets,
  canManageManagers,
  selectable = false,
  selected = false,
  onToggleSelect,
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
  const isOwner = user.role === 'owner';
  const isManager = user.role === 'manager';
  const isSelf = currentUser?.id === user.id;
  const isPending = user.status === 'pending';
  const { mutateAsync: removeMember } = useRemoveMemberFromOrganization();
  const { mutateAsync: leaveOrganization } = useLeaveOrganization();

  const confirm = useConfirmation();

  const handleRemoveMember = useCallback(() => {
    confirm({
      title: 'Remove member',
      description: `Remove ${user.name} from this team? ${REMOVE_MEMBER_EFFECT}`,
      type: 'danger',
      okLabel: 'Remove member',
      onOk: async () => {
        await removeMember({ organizationId, userId: user.id });
      },
    });
  }, [organizationId, user.id, user.name, confirm, removeMember]);

  const handleCancelInvite = useCallback(() => {
    confirm({
      title: 'Cancel invite',
      description: `Cancel the invite to ${user.name}? They will no longer be able to join with it.`,
      okLabel: 'Cancel invite',
      cancelLabel: 'Keep invite',
      onOk: async () => {
        await cancelInvite({
          id: organizationId,
          type: InviteType.Organization,
          // By id: the pending-users list carries no address for non-admins, and a cancel
          // naming nobody would cancel every open invite to the organization.
          userId: user.id,
        });
      },
    });
  }, [confirm, cancelInvite, organizationId, user.id, user.name]);

  const handleLeaveOrganization = useCallback(() => {
    confirm({
      title: 'Leave team',
      description: `Leave ${organization.name}? You will lose access to its groups, data lakes and credits until you are invited again.`,
      type: 'danger',
      okLabel: 'Leave team',
      onOk: async () => {
        await leaveOrganization({ organizationId });
        navigate({ to: '/organizations' });
      },
    });
  }, [confirm, organization.name, organizationId, leaveOrganization, navigate]);

  // The owner row is excluded from roster actions but not from budgets: the owner's own spend from
  // the pool is capped like anyone's. Your own row offers Leave team, never Remove member.
  const canRevoke = canRevokeMembers && !isPending && !isOwner && !isSelf;
  const canLeave = !isPending && !isOwner && isSelf;
  const canCancelInvite = isPending && canInviteMembers;
  // Appointing needs an active member row (setOrganizationManager); removal is always allowed.
  const canToggleManager =
    canManageManagers && !isPending && !isOwner && (isManager || (!user.isBanned && orgAclRowConfersMembership(user)));
  const setManager = useSetOrganizationManager();
  const canSetCreditLimit = canManageCreditBudgets && !isPending;
  const hasOtherActions = canSetCreditLimit || canToggleManager || canCancelInvite || canRevoke;

  const [editingLimit, setEditingLimit] = useState(false);
  const setOverride = useSetMemberCreditOverride();
  const creditUsage = user.creditUsage;
  const creditUsageCell = creditUsage ? (
    <Typography
      level="body-sm"
      component="span"
      sx={{ color: creditUsage.tracked ? 'text.primary' : 'text.tertiary', whiteSpace: 'nowrap' }}
      data-testid="organization-user-card-credit-usage"
    >
      {formatMemberCreditUsage(creditUsage)}
      {creditUsage.isOverride && (
        <Typography level="body-xs" component="span" sx={{ color: 'text.tertiary', ml: 0.5 }}>
          (own limit)
        </Typography>
      )}
    </Typography>
  ) : (
    <ExplainedDash
      testId="organization-user-card-credit-usage"
      explanation={isPending ? 'No usage yet: this invite is still pending' : 'Only team managers can see member usage'}
    />
  );

  const lastActiveTitle = formatLastActiveTitle(user.lastActiveAt);
  const lastActiveCell = lastActiveTitle ? (
    <Typography
      level="body-sm"
      component="span"
      title={lastActiveTitle}
      data-testid="organization-user-card-last-active"
      sx={{ whiteSpace: 'nowrap' }}
    >
      {formatAccountAge(user.lastActiveAt)}
    </Typography>
  ) : (
    <ExplainedDash testId="organization-user-card-last-active" explanation="No activity recorded" />
  );

  const statusChips = (
    <>
      {user.isBanned && (
        <Chip size="sm" variant="soft" color="danger">
          Deactivated
        </Chip>
      )}
      {isPending && (
        <Chip size="sm" variant="soft" color="warning" data-testid="organization-user-card-pending-chip">
          Pending
        </Chip>
      )}
    </>
  );

  const roleChip = (
    <Chip
      size="sm"
      variant="soft"
      color={isOwner ? 'primary' : isManager ? 'success' : 'neutral'}
      data-testid={`organization-user-card-${user.role}-chip`}
    >
      {t(`organization.roles.${user.role}`)}
    </Chip>
  );

  // Not a role: share/update on the ACL row opens the Settings tab (canManageOrg in
  // routes/organizations/$id.tsx), so the owner needs to see who holds it.
  const settingsAccessChip = user.role === 'member' &&
    user.permissions.some(p => p === Permission.share || p === Permission.update) && (
      <Chip size="sm" variant="outlined" data-testid="organization-user-card-settings-access-chip">
        {t('organization.access.can_edit_settings')}
      </Chip>
    );

  const selectCell = selectable && (
    <Box display="flex" alignItems="center">
      {onToggleSelect && (
        <Checkbox
          size="sm"
          checked={selected}
          onChange={onToggleSelect}
          slotProps={{ input: { 'aria-label': `Select ${user.name}`, 'data-testid': 'organization-user-card-select' } }}
        />
      )}
    </Box>
  );

  const actionsMenu = (hasOtherActions || canLeave) && (
    <Dropdown>
      <MenuButton
        className="organization-user-card-menu-button"
        data-testid="org-user-card-menu-btn"
        aria-label={`Actions for ${user.name}`}
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
        {canToggleManager && (
          <MenuItem
            onClick={() => setManager.mutate({ organizationId, userId: user.id, isManager: !isManager })}
            disabled={setManager.isPending}
            data-testid={isManager ? 'organization-user-card-remove-manager' : 'organization-user-card-make-manager'}
          >
            {isManager ? 'Remove manager' : 'Make manager'}
          </MenuItem>
        )}
        {canCancelInvite && (
          <MenuItem onClick={handleCancelInvite} data-testid="organization-user-card-cancel-invite">
            Cancel invite
          </MenuItem>
        )}
        {canRevoke && (
          <MenuItem color="danger" onClick={handleRemoveMember} data-testid="organization-user-card-remove-member">
            Remove member
          </MenuItem>
        )}
        {canLeave && hasOtherActions && <ListDivider data-testid="organization-user-card-leave-divider" />}
        {canLeave && (
          <MenuItem color="danger" onClick={handleLeaveOrganization} data-testid="organization-user-card-leave">
            Leave team
          </MenuItem>
        )}
      </Menu>
    </Dropdown>
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

  const avatar = (
    <Avatar className="organization-user-card-avatar" size="sm" variant="soft" src={avatarUrl}>
      {user.name.charAt(0).toUpperCase()}
    </Avatar>
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
          {selectCell}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            {avatar}
            <Stack sx={{ minWidth: 0 }}>
              <Box
                className="organization-user-card-name"
                sx={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {user.name}
              </Box>
              {user.email && (
                <Typography level="body-xs" noWrap data-testid="organization-user-card-email">
                  {user.email}
                </Typography>
              )}
              <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                {roleChip}
                {settingsAccessChip}
                {statusChips}
                {creditUsageCell}
              </Stack>
            </Stack>
          </Stack>
          <Box sx={{ flexShrink: 0 }}>{actionsMenu}</Box>
        </Stack>
        {creditLimitModal}
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
        gridTemplateColumns: rosterGridColumns(selectable),
        columnGap: '12px',
        width: '100%',
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: theme.palette.primary.softBg,
        alignItems: 'center',
        padding: '12px 15px',
        position: 'relative',
      })}
    >
      {selectCell}
      <Stack
        className="organization-user-card-user-stack"
        direction="row"
        spacing={1.5}
        alignItems="center"
        minWidth={0}
      >
        {avatar}
        <Box className="organization-user-card-name" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {user.name}
        </Box>
        {statusChips}
      </Stack>
      <Typography level="body-sm" noWrap data-testid="organization-user-card-email">
        {user.email}
      </Typography>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        {roleChip}
        {settingsAccessChip}
      </Stack>
      <Box className="organization-user-card-credits">{creditUsageCell}</Box>
      <Box>{lastActiveCell}</Box>
      <Box className="organization-user-card-actions" display="flex" justifyContent="flex-end">
        {actionsMenu}
      </Box>
      {creditLimitModal}
    </Box>
  );
};

export default OrganizationUserCard;
