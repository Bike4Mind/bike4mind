import {
  canAdministerOrganization,
  canRevokeOrgMember,
  canManageMemberCreditBudgets,
  InviteType,
  IOrganizationDocument,
  isOrgMember,
  isOrgOwnerOrCurrentAdmin,
  isOrgOwnerOrPlatformAdmin,
  Permission,
} from '@bike4mind/common';
import GenericAddItemsModal from '@client/app/components/common/GenericAddItemsModal';
import UserCard from '@client/app/components/common/UserCard';
import { useUser } from '@client/app/contexts/UserContext';
import { useCancelInvite, useShareDocument } from '@client/app/hooks/data/invites';
import { useGetOrganizationUsers, useGetPendingOrganizationUsers, useGetUsers } from '@client/app/hooks/data/user';
import { IGetUsersParams } from '@client/app/utils/userAPICalls';
import { Box, Button, Card, Chip, Stack, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import debounce from 'lodash/debounce';
import AddIcon from '@mui/icons-material/Add';
import { FC, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { OrganizationRosterRow } from './UserCard';
import MemberCreditBudgetCard from './MemberCreditBudgetCard';
import MemberRoster from './MemberRoster';
import { getMemberCreditUsage } from './memberCreditBudget';
import { getMemberRole } from './memberRosterView';
import { useOrganizationInvites, useOrganizationSeats } from '@client/app/hooks/data/organizations';

import { z } from 'zod';

interface OrganizationMembersProps {
  organization: IOrganizationDocument;
}

const OrganizationMembers: FC<OrganizationMembersProps> = ({ organization }) => {
  const {
    data: users,
    isLoading: membersLoading,
    isError: membersError,
    refetch: refetchMembers,
  } = useGetOrganizationUsers(organization.id);
  const { currentUser } = useUser();
  const { data: pendingUsers } = useGetPendingOrganizationUsers(organization.id);
  const { maxSeats, currentSeats, availableSeats } = useOrganizationSeats(organization.id);
  const { data: pendingInvites, isError: pendingInvitesError } = useOrganizationInvites(organization.id);
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const hasAvailableSeats = maxSeats === 0 || availableSeats > 0;
  const seatUsagePercentage = maxSeats > 0 ? (currentSeats / maxSeats) * 100 : 100;

  // For the add members modal
  const [modalSearch, setModalSearch] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const params: IGetUsersParams = useMemo(
    () => ({
      search: modalSearch,
      page: 1,
      limit: 10,
      publicView: true,
      pendingInviteOrganizationId: organization.id,
    }),
    [modalSearch, organization.id]
  );
  const { data: usersData, isFetching } = useGetUsers(params, { enabled: modalSearch.length >= 3 });

  const [permissions] = useState<{ value: Permission[]; error?: string | null }>({
    value: [Permission.read],
    error: null,
  });

  const shareDocument = useShareDocument({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', organization.id] });
      queryClient.invalidateQueries({ queryKey: ['organizations', organization.id, 'invites'] });

      setModalSearch('');
      setSelectedUserIds([]);
      toast.success(t('organizations.modals.members.invited', 'Member invited to team'));
    },
    onError: err => {
      toast.error(err.message);
    },
  });

  const cancelEmailInvite = useCancelInvite({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations', organization.id, 'invites'] });
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', organization.id] });
      toast.success('Invitation cancelled');
    },
    onError: error => toast.error(error.message),
  });

  const debouncedModalSearch = useMemo(() => debounce(setModalSearch, 300), []);

  const members = useMemo((): OrganizationRosterRow[] => {
    const showUsage = !!currentUser && canManageMemberCreditBudgets(currentUser, organization);
    const accepted = (users ?? []).map(u => {
      const permissions = organization.users.find(m => m.userId === u.id)?.permissions || [];
      return {
        ...u,
        status: 'accepted' as const,
        permissions,
        role: getMemberRole(organization, u.id),
        creditUsage: showUsage ? getMemberCreditUsage(organization, u.id) : null,
      };
    });
    // An invite cannot make someone the owner or a manager, so a pending row is a plain member.
    const pending = (pendingUsers ?? [])
      .filter(user => !pendingInvites || pendingInvites.some(invite => invite.recipients?.pending?.includes(user.id)))
      .map(u => ({ ...u, status: 'pending' as const, permissions: [], role: 'member' as const, creditUsage: null }));
    return [...accepted, ...pending];
  }, [users, pendingUsers, pendingInvites, organization, currentUser]);

  // Each roster control mirrors the server predicate behind its own endpoint; only the owner may
  // revoke a manager.
  // Invites (create + cancel) gate on isOrgMember, then isOrgOwnerOrCurrentAdmin, in sharingService;
  // an appointed admin whose users[] row lacks read/write fails the first check.
  const canInviteMembers =
    !!currentUser && isOrgMember(currentUser, organization) && isOrgOwnerOrCurrentAdmin(currentUser, organization);
  // DELETE /members/:userId gates on canRevokeOrgMember in organizationService.revokeAccess, which
  // also depends on the target; this coarse flag only decides whether the seats card and the
  // roster's selection column show.
  const canRevokeMembers = !!currentUser && canAdministerOrganization(currentUser, organization);

  // Mirrors the server gate on the credit-budget routes.
  const canManageCreditBudgets = !!currentUser && canManageMemberCreditBudgets(currentUser, organization);

  // Mirrors the owner-only gate on the manager route (organizationService.setOrganizationManager).
  const canManageManagers =
    !!currentUser && !organization.personal && isOrgOwnerOrPlatformAdmin(currentUser, organization);

  // Owner ID, falling back to the current user.
  const ownerId = useMemo(() => {
    return organization.userId || currentUser?.id || '';
  }, [organization.userId, currentUser]);

  // For the add members modal
  const modalUsers = useMemo(() => (usersData?.users ?? []).filter(u => u.id !== ownerId), [usersData?.users, ownerId]);

  const handleAddMembers = useCallback(
    (selectedUserIds: string[]) => {
      selectedUserIds.forEach(id => {
        shareDocument.mutate({
          description: `You've been invited to join the team`,
          recipients: [id],
          id: organization.id,
          type: InviteType.Organization,
          permissions: permissions.value,
        });
      });
    },
    [organization.id, permissions.value, shareDocument]
  );

  const pendingEmails = useMemo(
    () =>
      new Set(
        (pendingInvites ?? []).flatMap(invite => invite.recipients?.pending ?? []).map(email => email.toLowerCase())
      ),
    [pendingInvites]
  );

  const renderNoResults = useCallback(
    (term: string) => {
      const email = term.trim().toLowerCase();
      const canInvite =
        term === modalSearch &&
        !isFetching &&
        z.email().safeParse(email).success &&
        email !== currentUser?.email?.toLowerCase() &&
        !pendingEmails.has(email) &&
        canInviteMembers &&
        hasAvailableSeats;
      return (
        <Stack spacing={1} alignItems="center">
          <Typography level="body-sm">Enter their full email address to invite them to the team.</Typography>
          {canInvite && (
            <Button
              data-testid="organization-invite-by-email-btn"
              loading={shareDocument.isPending}
              onClick={() =>
                shareDocument.mutate({
                  description: "You've been invited to join the team",
                  recipients: [email],
                  id: organization.id,
                  type: InviteType.Organization,
                  permissions: permissions.value,
                })
              }
            >
              Invite {email} by email
            </Button>
          )}
        </Stack>
      );
    },
    [
      modalSearch,
      isFetching,
      currentUser?.email,
      pendingEmails,
      canInviteMembers,
      hasAvailableSeats,
      shareDocument,
      organization.id,
      permissions.value,
    ]
  );
  const pendingEmailInvites = (pendingInvites ?? []).flatMap(invite =>
    (invite.recipients?.pending ?? [])
      .filter(recipient => z.email().safeParse(recipient).success || recipient.includes('***@'))
      .map(email => ({ inviteId: invite.id, email }))
  );

  const alreadyInvitedUsers = useMemo(() => {
    const userMap = new Map<string, 'accepted' | 'pending'>();
    organization.users.forEach(member => userMap.set(member.userId, 'accepted'));
    pendingInvites?.forEach(invite => {
      invite.recipients?.pending?.forEach(recipient => {
        const key = recipient.toLowerCase();
        if (!userMap.has(key)) userMap.set(key, 'pending');
      });
    });
    return userMap;
  }, [organization.users, pendingInvites]);

  const getInviteStatus = useCallback(
    (user: { id: string; email?: string | null; username?: string; pendingInvite?: boolean }) => {
      if (user.pendingInvite) return 'pending' as const;
      return (
        alreadyInvitedUsers.get(user.id) ||
        alreadyInvitedUsers.get(user.email?.toLowerCase() ?? '') ||
        alreadyInvitedUsers.get(user.username ?? '') ||
        undefined
      );
    },
    [alreadyInvitedUsers]
  );

  const renderUserItem = useCallback(
    (user: any, isSelected: boolean, onSelect: () => void) => {
      const inviteStatus = getInviteStatus(user);
      return (
        <UserCard
          user={user}
          inviteStatus={inviteStatus}
          onClick={!!inviteStatus ? undefined : onSelect}
          checked={isSelected}
          hideEmail
        />
      );
    },
    [getInviteStatus]
  );

  return (
    <Card
      className="organization-members-container"
      variant="outlined"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: { xs: '12px', sm: '20px' },
        p: { xs: 1.5, sm: '20px' },
        height: '100%',
      }}
    >
      {/* Seats Management Section: read-only, shown to anyone who can change the roster */}
      {(canInviteMembers || canRevokeMembers) && (
        <Card
          className="organization-members-seats-card"
          data-testid="organization-members-seats-card"
          variant="outlined"
          sx={{ mx: { xs: 0, sm: '20px' } }}
        >
          <Stack spacing={2} p={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
              <Typography className="organization-members-seats-title" level="title-sm">
                Seat Management
              </Typography>
              {maxSeats === 0 ? (
                <Chip className="organization-members-no-plan-chip" size="sm" color="danger" variant="soft">
                  No Active Plan
                </Chip>
              ) : (
                <Chip
                  className="organization-members-seats-chip"
                  size="sm"
                  color={seatUsagePercentage >= 90 ? 'danger' : seatUsagePercentage >= 75 ? 'warning' : 'success'}
                  variant="soft"
                >
                  {availableSeats} seats available
                </Chip>
              )}
            </Stack>

            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography
                  className="organization-members-seats-count"
                  data-testid="organization-members-seats-count"
                  level="body-sm"
                >
                  {currentSeats} of {maxSeats || '∞'} seats used
                </Typography>
                <Typography
                  className="organization-members-seats-percentage"
                  level="body-sm"
                  color={seatUsagePercentage >= 90 ? 'danger' : 'neutral'}
                >
                  {maxSeats > 0 ? `${Math.round(seatUsagePercentage)}%` : '-'}
                </Typography>
              </Stack>
              {maxSeats > 0 && (
                <Box
                  className="organization-members-seats-progress-container"
                  sx={{
                    width: '100%',
                    bgcolor: 'background.level2',
                    borderRadius: 'sm',
                    height: '6px',
                    overflow: 'hidden',
                  }}
                >
                  <Box
                    className="organization-members-seats-progress-bar"
                    sx={{
                      width: `${seatUsagePercentage}%`,
                      bgcolor:
                        seatUsagePercentage >= 90
                          ? 'danger.500'
                          : seatUsagePercentage >= 75
                            ? 'warning.500'
                            : 'success.500',
                      height: '100%',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </Box>
              )}
            </Stack>

            {!hasAvailableSeats && (
              <Typography
                className="organization-members-seats-limit"
                data-testid="organization-members-seats-limit"
                level="body-sm"
                color="danger"
              >
                You&apos;ve reached your seat limit. Upgrade your plan to add more members.
              </Typography>
            )}
          </Stack>
        </Card>
      )}

      <MemberCreditBudgetCard organization={organization} canManage={canManageCreditBudgets} />

      {/* Add members */}
      <Stack className="organization-members-search-container" spacing={1} mx={{ xs: 0, sm: '20px' }}>
        <Box display="flex" gap="10px">
          {canInviteMembers &&
            (hasAvailableSeats ? (
              <GenericAddItemsModal
                title={t('organizations.modals.members.title', 'Add Members to Team')}
                subtitle={t(
                  'organizations.modals.members.subtitle',
                  `Search for users to add to this team (${availableSeats} seats available)`
                )}
                buttonLabel={t('organizations.modals.members.button_label', 'Add Member')}
                buttonIcon={<AddIcon />}
                triggerTestId="organization-members-add-btn"
                items={modalUsers}
                selectedIds={selectedUserIds}
                onSelectIds={ids => {
                  // Only allow selecting up to available seats
                  if (maxSeats > 0 && ids.length > availableSeats) {
                    toast.error(`You can only add up to ${availableSeats} more members with your current plan`);
                    return;
                  }
                  setSelectedUserIds(ids);
                }}
                getItemId={user => user.id}
                onSearch={term => debouncedModalSearch(term)}
                searchPlaceholder={t('common.search_users', 'Search users')}
                searchMinLength={3}
                onAdd={handleAddMembers}
                isPending={shareDocument.isPending}
                renderItem={renderUserItem}
                isItemDisabled={user => !!getInviteStatus(user)}
                renderNoResults={renderNoResults}
                isLoadingMore={isFetching}
                showButtonBadge={false}
              />
            ) : (
              <Button
                className="organization-members-add-button"
                data-testid="organization-members-add-no-seats-btn"
                size="sm"
                variant="outlined"
                color="danger"
                startDecorator={<AddIcon />}
                onClick={() =>
                  toast.error(t('organizations.errors.no_seats', 'No seats available. Please upgrade your plan.'))
                }
                sx={{ opacity: 0.75 }}
              >
                {t('organizations.modals.members.button_label', 'Add Member')}
              </Button>
            ))}
        </Box>
      </Stack>

      {pendingInvitesError && (
        <Typography color="danger" data-testid="organization-pending-invites-error">
          Pending invitations could not be loaded. Try again.
        </Typography>
      )}
      {pendingEmailInvites.length > 0 && (
        <Stack spacing={1} data-testid="organization-pending-email-invites">
          <Typography level="title-sm">Pending email invitations</Typography>
          {pendingEmailInvites.map(({ inviteId, email }) => (
            <Stack key={`${inviteId}:${email}`} direction="row" spacing={1} alignItems="center">
              <Typography level="body-sm">{email}</Typography>
              {canInviteMembers && !email.includes('*') && (
                <Button
                  size="sm"
                  variant="outlined"
                  data-testid="organization-cancel-email-invite-btn"
                  loading={cancelEmailInvite.isPending}
                  onClick={() =>
                    cancelEmailInvite.mutate({ id: organization.id, type: InviteType.Organization, email })
                  }
                >
                  Cancel invitation
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
      )}
      <MemberRoster
        organization={organization}
        members={members}
        isLoading={membersLoading}
        isError={membersError}
        onRetry={() => refetchMembers()}
        currentUserId={currentUser?.id}
        canInviteMembers={canInviteMembers}
        canRevokeMembers={canRevokeMembers}
        canRevokeMember={userId => !!currentUser && canRevokeOrgMember(currentUser, organization, userId)}
        canManageCreditBudgets={canManageCreditBudgets}
        canManageManagers={canManageManagers}
      />
    </Card>
  );
};

export default OrganizationMembers;
