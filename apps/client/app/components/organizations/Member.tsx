import {
  canAdministerOrganization,
  canRevokeOrgMember,
  canManageMemberCreditBudgets,
  InviteType,
  IOrganizationDocument,
  isOrgMember,
  isOrgOwnerOrCurrentAdmin,
  isOrgOwnerOrPlatformAdmin,
  ORG_INVITE_ROLES,
  OrgInviteRole,
} from '@bike4mind/common';
import GenericAddItemsModal from '@client/app/components/common/GenericAddItemsModal';
import UserCard from '@client/app/components/common/UserCard';
import { useUser } from '@client/app/contexts/UserContext';
import { useShareDocument } from '@client/app/hooks/data/invites';
import { useGetOrganizationUsers, useGetUsers } from '@client/app/hooks/data/user';
import { canViewOrgBilling, OrganizationTabs } from '@client/app/routes/organizations/orgTabAccess';
import { IGetUsersParams } from '@client/app/utils/userAPICalls';
import { Button, Link, Stack, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import debounce from 'lodash/debounce';
import AddIcon from '@mui/icons-material/Add';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import { FC, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { OrganizationRosterRow } from './UserCard';
import BulkInviteModal from './BulkInviteModal';
import InviteLinksPanel from './InviteLinksPanel';
import OrgInviteRoleSelect from './OrgInviteRoleSelect';
import MemberCreditBudgetCard from './MemberCreditBudgetCard';
import MyOrgNotificationPrefsCard from './MyOrgNotificationPrefsCard';
import OrgBudgetAlertsCard from './OrgBudgetAlertsCard';
import OrganizationMfaPolicy from './OrganizationMfaPolicy';
import MemberRoster from './MemberRoster';
import { getMemberCreditUsage } from './memberCreditBudget';
import { getMemberRole } from './memberRosterView';
import OrgSeatSummary from './OrgSeatSummary';
import PendingInvitationsTable from './PendingInvitationsTable';
import { summarizeInviteResults } from './inviteResultSummary';
import { useOrganizationInvites, useOrganizationSeats } from '@client/app/hooks/data/organizations';

import { z } from 'zod';

interface OrganizationMembersProps {
  organization: IOrganizationDocument;
}

const OrganizationMembersView: FC<OrganizationMembersProps> = ({ organization }) => {
  const {
    data: users,
    isLoading: membersLoading,
    isError: membersError,
    refetch: refetchMembers,
  } = useGetOrganizationUsers(organization.id);
  const { currentUser } = useUser();
  const { maxSeats, availableSeats } = useOrganizationSeats(organization.id);
  const { data: pendingInvites, isError: pendingInvitesError } = useOrganizationInvites(organization.id);
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const hasAvailableSeats = maxSeats === 0 || availableSeats > 0;
  // Seats are bought on the Billing tab, which only the owner can open (orgTabAccess.canViewOrgBilling).
  const canAddSeats = canViewOrgBilling(currentUser, organization);

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

  const [role, setRole] = useState<OrgInviteRole>('viewer');
  const [bulkInviteOpen, setBulkInviteOpen] = useState(false);
  // Mirrors the server gate in sharingService.createInvite: only the owner tier may invite an admin.
  const canGrantAdmin = !!currentUser && isOrgOwnerOrPlatformAdmin(currentUser, organization);

  // Results are reported once per batch by sendInvites, so the hook's per-request toasts are muted.
  const shareDocument = useShareDocument({ onSuccess: () => {}, onError: () => {} });
  const [sending, setSending] = useState(false);

  // One request per recipient, so one refused invite does not sink the rest; one summary toast.
  const sendInvites = useCallback(
    async (recipients: string[]) => {
      setSending(true);
      try {
        const results = await Promise.allSettled(
          recipients.map(recipient =>
            shareDocument.mutateAsync({
              recipients: [recipient],
              id: organization.id,
              type: InviteType.Organization,
              permissions: [...ORG_INVITE_ROLES[role]],
            })
          )
        );
        const summary = summarizeInviteResults(results);
        toast[summary.kind](summary.message);
        if (summary.kind !== 'error') {
          setModalSearch('');
          setSelectedUserIds([]);
        }
      } finally {
        setSending(false);
        queryClient.invalidateQueries({ queryKey: ['users', 'organization', organization.id] });
        queryClient.invalidateQueries({ queryKey: ['organizations', organization.id, 'invites'] });
      }
    },
    [organization.id, queryClient, role, shareDocument]
  );

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
    // Pending invites are listed once, in PendingInvitationsTable, not as roster rows.
    return accepted;
  }, [users, organization, currentUser]);

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

  // Alerts live on this tab rather than Settings because an appointed manager with only a read
  // row cannot open Settings. Prefs mirror the my-notification-prefs route: owner or current
  // manager only, never a platform admin, never a personal org.
  const canManageBudgetAlerts = canManageCreditBudgets && !organization.personal;
  const isOrgAlertRecipient =
    !!currentUser &&
    !organization.personal &&
    isOrgOwnerOrCurrentAdmin({ id: currentUser.id, isAdmin: false }, organization);

  // Mirrors OrganizationMfaPolicy's own gate, so the policies heading never shows over nothing.
  const canManageMfa = !!currentUser && !organization.personal && isOrgOwnerOrCurrentAdmin(currentUser, organization);

  // Mirrors the owner-only gate on the manager route (organizationService.setOrganizationManager).
  const canManageManagers =
    !!currentUser && !organization.personal && isOrgOwnerOrPlatformAdmin(currentUser, organization);

  // Owner ID, falling back to the current user.
  const ownerId = useMemo(() => {
    return organization.userId || currentUser?.id || '';
  }, [organization.userId, currentUser]);

  // For the add members modal
  const modalUsers = useMemo(() => (usersData?.users ?? []).filter(u => u.id !== ownerId), [usersData?.users, ownerId]);

  const handleAddMembers = useCallback((ids: string[]) => void sendInvites(ids), [sendInvites]);

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
              loading={sending}
              onClick={() => void sendInvites([email])}
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
      sending,
      sendInvites,
    ]
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

  const showPolicies =
    canManageCreditBudgets || organization.maxCreditsPerMember != null || canManageMfa || isOrgAlertRecipient;

  // Regions follow the admin design guide: 24px between regions, 16px between cards, and no
  // wrapper card around the tab (each section is its own card).
  return (
    <Stack spacing={3} data-testid="organization-members-tab" sx={{ minWidth: 0 }}>
      <Stack spacing={2}>
        <OrgSeatSummary organizationId={organization.id} />
        {canInviteMembers && (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
            {hasAvailableSeats ? (
              <GenericAddItemsModal
                title={t('organizations.modals.members.title', 'Add Members to Team')}
                subtitle={t(
                  'organizations.modals.members.subtitle',
                  `Search for users to add to this team (${availableSeats} seats available)`
                )}
                buttonLabel={t('organizations.modals.members.button_label', 'Add Member')}
                buttonIcon={<AddIcon />}
                triggerTestId="organization-members-add-btn"
                triggerSize="sm"
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
                isPending={sending}
                renderItem={renderUserItem}
                isItemDisabled={user => !!getInviteStatus(user)}
                renderNoResults={renderNoResults}
                isLoadingMore={isFetching}
                showButtonBadge={false}
                leftGridContent={
                  <OrgInviteRoleSelect
                    value={role}
                    onChange={setRole}
                    canGrantAdmin={canGrantAdmin}
                    testId="organization-members-role-select"
                  />
                }
              />
            ) : (
              <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                <Button
                  data-testid="organization-members-add-no-seats-btn"
                  size="sm"
                  variant="outlined"
                  startDecorator={<AddIcon />}
                  disabled
                  aria-describedby="organization-members-seats-limit"
                >
                  {t('organizations.modals.members.button_label', 'Add Member')}
                </Button>
                <Typography
                  id="organization-members-seats-limit"
                  data-testid="organization-members-seats-limit"
                  level="body-sm"
                  color="neutral"
                >
                  All seats are in use.{' '}
                  {canAddSeats ? (
                    <Link
                      component="button"
                      data-testid="organization-members-add-seats-link"
                      onClick={() =>
                        navigate({
                          to: '/organizations/$id',
                          params: { id: organization.id },
                          search: { tab: OrganizationTabs.Billing },
                          replace: true,
                        })
                      }
                    >
                      Add seats
                    </Link>
                  ) : (
                    'Ask the team owner to add seats.'
                  )}
                </Typography>
              </Stack>
            )}
            {hasAvailableSeats && (
              <Button
                data-testid="organization-members-bulk-invite-btn"
                size="sm"
                variant="outlined"
                startDecorator={<GroupAddIcon />}
                onClick={() => setBulkInviteOpen(true)}
              >
                {t('organizations.modals.bulk_invite.button_label', 'Bulk invite')}
              </Button>
            )}
            {bulkInviteOpen && (
              <BulkInviteModal
                organizationId={organization.id}
                availableSeats={availableSeats}
                canGrantAdmin={canGrantAdmin}
                onDone={() => setBulkInviteOpen(false)}
              />
            )}
          </Stack>
        )}
        {canInviteMembers && <InviteLinksPanel organizationId={organization.id} isOwnerTier={canGrantAdmin} />}
        <PendingInvitationsTable
          organizationId={organization.id}
          invites={pendingInvites}
          isError={pendingInvitesError}
          canManage={canInviteMembers}
          canGrantAdmin={canGrantAdmin}
          currentUserId={currentUser?.id}
        />
      </Stack>

      <MemberRoster
        organization={organization}
        members={members}
        isLoading={membersLoading}
        isError={membersError}
        onRetry={() => refetchMembers()}
        currentUserId={currentUser?.id}
        canRevokeMembers={canRevokeMembers}
        canRevokeMember={userId => !!currentUser && canRevokeOrgMember(currentUser, organization, userId)}
        canManageCreditBudgets={canManageCreditBudgets}
        canManageManagers={canManageManagers}
      />

      {showPolicies && (
        <Stack spacing={2} component="section" aria-labelledby="organization-members-policies-title">
          <Typography id="organization-members-policies-title" level="title-md" component="h3">
            Policies and alerts
          </Typography>
          <MemberCreditBudgetCard organization={organization} canManage={canManageCreditBudgets} />
          <OrganizationMfaPolicy
            key={`${organization.id}:${organization.mfaPolicy?.required}:${organization.mfaPolicy?.graceEndsAt}`}
            organization={organization}
          />
          {canManageBudgetAlerts && <OrgBudgetAlertsCard organizationId={organization.id} />}
          {isOrgAlertRecipient && <MyOrgNotificationPrefsCard organizationId={organization.id} />}
        </Stack>
      )}
    </Stack>
  );
};

const OrganizationMembers: FC<OrganizationMembersProps> = ({ organization }) => (
  <OrganizationMembersView key={organization.id} organization={organization} />
);

export default OrganizationMembers;
