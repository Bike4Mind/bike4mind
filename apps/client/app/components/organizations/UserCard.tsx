import {
  ASSIGNABLE_ORG_ROLES,
  AssignableOrgRole,
  IUserDocument,
  Permission,
  IOrganizationDocument,
  canAssignOrgRole,
  orgAclRowConfersMembership,
  organizationMemberRole,
} from '@bike4mind/common';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
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
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { FC, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useLeaveOrganization,
  useSetMemberCreditOverride,
  useSetOrganizationMemberRole,
} from '@client/app/hooks/data/organizations';
import { useNavigate } from '@tanstack/react-router';
import { formatAccountAge, formatLastActiveTitle } from '@client/app/components/admin/Users/formatAccountAge';
import CreditLimitModal from './CreditLimitModal';
import OffboardMemberDialog from './OffboardMemberDialog';
import { formatMemberCredits, formatMemberCreditUsage } from './memberCreditBudget';
import { RosterMember, rosterGridColumns, ROSTER_TABLE_QUERY } from './memberRosterView';

/** A roster row: the safe user shape plus its org standing. Pending invites are not rows (PendingInvitationsTable). */
export type OrganizationRosterRow = IUserDocument & RosterMember & { permissions: Permission[] };

interface OrganizationUserCardProps {
  organization: IOrganizationDocument;
  user: OrganizationRosterRow;
  /** Viewer may revoke a member (`canRevokeOrgMember`, the DELETE member route's gate). */
  canRevokeMembers: boolean;
  /** Viewer may set this member's monthly credit limit (`canManageMemberCreditBudgets`). */
  canManageCreditBudgets: boolean;
  /** The roster has a selection column; must match the header's `rosterGridColumns` argument. */
  selectable?: boolean;
  /** The roster has an Email column; must match the header's `rosterGridColumns` argument. */
  showEmails: boolean;
  selected?: boolean;
  /** Absent when this row cannot be bulk-removed: its selection cell stays empty. */
  onToggleSelect?: () => void;
}

/** Below the table breakpoint each cell stacks in its own row under the name; no empty email row. */
const narrowGridAreas = ({ selectable, showEmails }: { selectable: boolean; showEmails: boolean }): string => {
  const stacked = [...(showEmails ? ['email'] : []), 'role', 'credits', 'active'];
  return selectable
    ? ['"select name actions"', ...stacked.map(area => `". ${area} ${area}"`)].join(' ')
    : ['"name actions"', ...stacked.map(area => `"${area} ${area}"`)].join(' ');
};

/** Rows are table rows inside MemberRoster's framed list: hairline between rows, no per-row card. */
const rowSurface = {
  borderBottom: '1px solid',
  borderColor: 'divider',
  '&:last-of-type': { borderBottom: 'none' },
  '&:hover': { backgroundColor: 'background.level1' },
} as const;

// Admin status tones, as InitialsAvatar uses (admin/shared). The admin skin repaints Joy's solid
// neutral/success/warning as white secondary buttons, so a Joy `color` cannot give a fill here.
// Neutral is too faint on a light surface and bad reads as an error, so neither is offered.
const AVATAR_TONES = ['info', 'good', 'warn'] as const;

/** A stable avatar tone per user, so a person keeps theirs across visits. */
const avatarToneFor = (seed: string): (typeof AVATAR_TONES)[number] => {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
};

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
  canRevokeMembers,
  canManageCreditBudgets,
  selectable = false,
  showEmails,
  selected = false,
  onToggleSelect,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { currentUser } = useUser();
  const { id: organizationId } = organization;
  const avatarUrl = user.photoUrl ? getAppFileUrl({ key: user.photoUrl }) : '';
  const isOwner = user.role === 'owner';
  // Derived from the org lists: the roster's server-side `role` cannot carry 'billingManager'.
  const memberRole = organizationMemberRole(organization, user.id);
  const isSelf = currentUser?.id === user.id;
  const { mutateAsync: leaveOrganization } = useLeaveOrganization();

  const confirm = useConfirmation();
  const [offboarding, setOffboarding] = useState(false);

  const handleRemoveMember = useCallback(() => setOffboarding(true), []);

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
  const canRevoke = canRevokeMembers && !isOwner && !isSelf;
  const canLeave = !isOwner && isSelf;
  // Roles above Member need an active member row (setOrganizationMemberRole); moving to Member is
  // always allowed so a deactivated manager can still be demoted.
  const isAssignableRole = (role: AssignableOrgRole) =>
    canAssignOrgRole(currentUser ?? { id: '' }, organization, user.id, role) &&
    (role === 'member' || (!user.isBanned && orgAclRowConfersMembership(user)));
  const selectableRoles = ASSIGNABLE_ORG_ROLES.filter(role => role !== memberRole && isAssignableRole(role));
  const canChangeRole = !isOwner && !organization.personal && selectableRoles.length > 0;
  const setRole = useSetOrganizationMemberRole();
  const canSetCreditLimit = canManageCreditBudgets;
  const hasOtherActions = canSetCreditLimit || canRevoke;

  const [editingLimit, setEditingLimit] = useState(false);
  const setOverride = useSetMemberCreditOverride();
  const creditUsage = user.creditUsage;
  const creditUsageCell = creditUsage ? (
    <Typography
      level="body-sm"
      component="span"
      sx={{ color: creditUsage.tracked ? 'text.primary' : 'text.tertiary', whiteSpace: 'normal' }}
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
    <ExplainedDash testId="organization-user-card-credit-usage" explanation="Only team managers can see member usage" />
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
    </>
  );

  const roleChip =
    memberRole === 'billingManager' ? (
      <Chip size="sm" variant="outlined" color="success" data-testid="organization-user-card-billing-manager-chip">
        {t('organization.roles.billingManager')}
      </Chip>
    ) : (
      <Chip
        size="sm"
        variant="soft"
        color={isOwner ? 'primary' : memberRole === 'manager' ? 'success' : 'neutral'}
        // The neutral soft fill is close to the surface in both themes; one step up keeps the chip visible.
        sx={!isOwner && memberRole !== 'manager' ? { bgcolor: 'neutral.softHoverBg' } : undefined}
        data-testid={`organization-user-card-${user.role}-chip`}
      >
        {t(`organization.roles.${user.role}`)}
      </Chip>
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

  const selectCell = selectable && (
    <Box display="flex" alignItems="center" sx={{ gridArea: 'select', [ROSTER_TABLE_QUERY]: { gridArea: 'auto' } }}>
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
        aria-label={`Actions for ${user.name || user.email || 'member'}`}
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

  const avatar = (
    <Avatar
      className="organization-user-card-avatar"
      size="sm"
      src={avatarUrl}
      data-tone={avatarToneFor(user.id)}
      sx={theme => {
        const tone = theme.vars.palette.admin.status[avatarToneFor(user.id)];
        return { fontWeight: 600, color: tone.foreground, bgcolor: tone.background };
      }}
    >
      {user.name.charAt(0).toUpperCase()}
    </Avatar>
  );

  if (isMobile) {
    return (
      <Box
        className="organization-user-card-container"
        data-testid="organization-user-card"
        data-user-id={user.id}
        sx={{ ...rowSurface, padding: '8px 12px' }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          {selectCell}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            {avatar}
            <Stack sx={{ minWidth: 0 }}>
              <Box
                className="organization-user-card-name"
                data-testid="organization-user-card-name"
                sx={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {user.name}
              </Box>
              {showEmails && user.email && (
                <Typography level="body-xs" noWrap data-testid="organization-user-card-email">
                  {user.email}
                </Typography>
              )}
              <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                {roleChip}
                {statusChips}
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
      sx={{
        ...rowSurface,
        display: 'grid',
        gridTemplateColumns: `${selectable ? '32px ' : ''}minmax(0, 1fr) 48px`,
        gridTemplateAreas: narrowGridAreas({ selectable, showEmails }),
        rowGap: 0.5,
        [ROSTER_TABLE_QUERY]: {
          gridTemplateColumns: rosterGridColumns({ selectable, showEmails }),
          gridTemplateAreas: 'none',
          rowGap: 0,
        },
        columnGap: '12px',
        width: '100%',
        alignItems: 'center',
        padding: '8px 16px',
        position: 'relative',
      }}
    >
      {selectCell}
      <Stack
        className="organization-user-card-user-stack"
        direction="row"
        spacing={1.5}
        alignItems="center"
        minWidth={0}
        flexWrap="wrap"
        useFlexGap
        sx={{ gridArea: 'name', [ROSTER_TABLE_QUERY]: { gridArea: 'auto' } }}
      >
        {avatar}
        <Box
          className="organization-user-card-name"
          data-testid="organization-user-card-name"
          sx={{ minWidth: 0, flex: '1 1 100px', overflowWrap: 'anywhere' }}
        >
          {user.name}
        </Box>
        {statusChips}
      </Stack>
      {showEmails && (
        <Typography
          level="body-sm"
          data-testid="organization-user-card-email"
          title={user.email ?? undefined}
          sx={{
            gridArea: 'email',
            overflowWrap: 'anywhere',
            [ROSTER_TABLE_QUERY]: {
              gridArea: 'auto',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }}
        >
          {user.email}
        </Typography>
      )}
      <Stack
        direction="row"
        spacing={0.5}
        flexWrap="wrap"
        useFlexGap
        sx={{ gridArea: 'role', [ROSTER_TABLE_QUERY]: { gridArea: 'auto' } }}
      >
        {roleChip}
      </Stack>
      <Box
        className="organization-user-card-credits"
        sx={{ gridArea: 'credits', minWidth: 0, [ROSTER_TABLE_QUERY]: { gridArea: 'auto' } }}
      >
        <Typography
          component="span"
          level="body-sm"
          sx={{ color: 'text.secondary', [ROSTER_TABLE_QUERY]: { display: 'none' } }}
        >
          Credits this month:{' '}
        </Typography>
        {creditUsageCell}
      </Box>
      <Box sx={{ gridArea: 'active', [ROSTER_TABLE_QUERY]: { gridArea: 'auto' } }}>
        <Typography
          component="span"
          level="body-sm"
          sx={{ color: 'text.secondary', [ROSTER_TABLE_QUERY]: { display: 'none' } }}
        >
          Last active:{' '}
        </Typography>
        {lastActiveCell}
      </Box>
      <Box
        className="organization-user-card-actions"
        display="flex"
        gap="8px"
        justifyContent="flex-end"
        sx={{
          gridArea: 'actions',
          alignSelf: 'start',
          [ROSTER_TABLE_QUERY]: { gridArea: 'auto', alignSelf: 'center' },
        }}
      >
        {roleSelect}
        {actionsMenu}
      </Box>
      {creditLimitModal}
      {offboardDialog}
    </Box>
  );
};

export default OrganizationUserCard;
