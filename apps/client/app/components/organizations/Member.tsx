import { InviteType, IOrganizationDocument, IUserDocument, Permission } from '@bike4mind/common';
import GenericAddItemsModal from '@client/app/components/common/GenericAddItemsModal';
import UserCard from '@client/app/components/common/UserCard';
import { useUser } from '@client/app/contexts/UserContext';
import { useShareDocument } from '@client/app/hooks/data/invites';
import { useGetOrganizationUsers, useGetPendingOrganizationUsers, useGetUsers } from '@client/app/hooks/data/user';
import { IGetUsersParams } from '@client/app/utils/userAPICalls';
import SearchIcon from '@mui/icons-material/Search';
import { Box, Button, Card, Chip, IconButton, Input, Stack, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { debounce } from 'lodash';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import AddIcon from '@mui/icons-material/Add';
import { FC, Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import OrganizationUserCard from './UserCard';
import { useOrganizationSeats } from '@client/app/hooks/data/organizations';

interface OrganizationMembersProps {
  organization: IOrganizationDocument;
  userPermissions: Permission[];
}

const OrganizationMembers: FC<OrganizationMembersProps> = ({ organization, userPermissions }) => {
  const { data: users } = useGetOrganizationUsers(organization.id);
  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const { currentUser } = useUser();
  const { data: pendingUsers } = useGetPendingOrganizationUsers(organization.id);
  const { maxSeats, currentSeats, availableSeats } = useOrganizationSeats(organization.id);
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const hasAvailableSeats = maxSeats === 0 || availableSeats > 0;
  const seatUsagePercentage = maxSeats > 0 ? (currentSeats / maxSeats) * 100 : 100;

  // For the add members modal
  const [modalSearch, setModalSearch] = useState('');
  const [selectedUserNames, setSelectedUserNames] = useState<string[]>([]);
  const params: IGetUsersParams = useMemo(
    () => ({ search: modalSearch, page: 1, limit: 10, publicView: true }),
    [modalSearch]
  );
  const { data: usersData, isFetching } = useGetUsers(params, { enabled: modalSearch.length >= 3 });

  const [permissions] = useState<{ value: Permission[]; error?: string | null }>({
    value: [Permission.read],
    error: null,
  });

  const shareDocument = useShareDocument({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', organization.id] });

      setModalSearch('');
      setSelectedUserNames([]);
      toast.success(t('organizations.modals.members.invited', 'Member invited to organization'));
    },
    onError: err => {
      toast.error(err.message);
    },
  });

  const toggleSortOrder = () => {
    setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
  };

  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
      }, 300),
    []
  );

  const debouncedModalSearch = useMemo(() => debounce(setModalSearch, 300), []);

  // Filter and sort users
  const filteredUsers = useMemo(() => {
    let result: (IUserDocument & { status: 'accepted' | 'pending'; permissions: Permission[]; usedCredits: number })[] =
      users?.map(u => ({
        ...u,
        status: 'accepted' as const,
        permissions: organization.users.find(m => m.userId === u.id)?.permissions || [],
        usedCredits: organization.userDetails?.find(m => m.id === u.id)?.usedCredits || 0,
      })) || [];
    result.push(
      ...(pendingUsers?.map(u => ({ ...u, status: 'pending' as const, permissions: [], usedCredits: 0 })) || [])
    );

    if (search) {
      const searchLower = search.toLowerCase();
      result = result.filter(
        user => user.name.toLowerCase().includes(searchLower) || user.email?.toLowerCase().includes(searchLower)
      );
    }

    return result.sort((a, b) => (sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)));
  }, [users, search, sortOrder, pendingUsers, organization.users, organization.userDetails]);

  const canManageMembers = useMemo(() => {
    return userPermissions.includes(Permission.share) || userPermissions.includes(Permission.update);
  }, [userPermissions]);

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
          description: `You've been invited to join the organization`,
          recipients: [id],
          id: organization.id,
          type: InviteType.Organization,
          permissions: permissions.value,
        });
      });
    },
    [organization.id, permissions.value, shareDocument]
  );

  const alreadyInvitedUsers = useMemo(() => {
    const userMap = new Map<string, 'accepted' | 'pending'>();
    organization.users.forEach(member => userMap.set(member.userId, 'accepted'));
    pendingUsers?.forEach(user => userMap.set(user.id, 'pending'));
    return userMap;
  }, [organization.users, pendingUsers]);

  const getInviteStatus = useCallback(
    (user: any) => {
      return (
        alreadyInvitedUsers.get(user.id) ||
        alreadyInvitedUsers.get(user.email ?? '') ||
        alreadyInvitedUsers.get(user.username) ||
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
      {/* Seats Management Section */}
      {canManageMembers && (
        <Card className="organization-members-seats-card" variant="outlined" sx={{ mx: { xs: 0, sm: '20px' } }}>
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
                <Typography className="organization-members-seats-count" level="body-sm">
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
              <Typography className="organization-members-seats-limit" level="body-sm" color="danger">
                You&apos;ve reached your seat limit. Upgrade your plan to add more members.
              </Typography>
            )}
          </Stack>
        </Card>
      )}

      {/* Search and Actions Section */}
      <Stack className="organization-members-search-container" spacing={1} mx={{ xs: 0, sm: '20px' }}>
        <Input
          className="organization-members-search-input"
          placeholder="Search by name or email"
          onChange={e => {
            debouncedSearch(e.target.value);
          }}
          startDecorator={
            <SearchIcon
              className="organization-members-search-icon"
              sx={theme => ({
                width: '20px',
                height: '20px',
                '&:focus': {
                  color: theme.palette.mode === 'dark' ? 'white' : 'black',
                },
              })}
            />
          }
        />
        <Box display="flex" gap="10px">
          <IconButton
            className="organization-members-sort-button"
            variant="outlined"
            onClick={toggleSortOrder}
            title={`Sort ${sortOrder === 'desc' ? 'Z to A' : 'A to Z'}`}
          >
            <SortByAlphaIcon sx={{ transform: sortOrder === 'desc' ? 'scaleY(-1)' : 'scaleY(1)' }} />
          </IconButton>

          {canManageMembers &&
            (hasAvailableSeats ? (
              <GenericAddItemsModal
                title={t('organizations.modals.members.title', 'Add Members to Organization')}
                subtitle={t(
                  'organizations.modals.members.subtitle',
                  `Search for users to add to this organization (${availableSeats} seats available)`
                )}
                buttonLabel={t('organizations.modals.members.button_label', 'Add Member')}
                buttonIcon={<AddIcon />}
                items={modalUsers}
                selectedIds={selectedUserNames}
                onSelectIds={ids => {
                  // Only allow selecting up to available seats
                  if (maxSeats > 0 && ids.length > availableSeats) {
                    toast.error(`You can only add up to ${availableSeats} more members with your current plan`);
                    return;
                  }
                  setSelectedUserNames(ids);
                }}
                getItemId={user => user.username}
                onSearch={term => debouncedModalSearch(term)}
                searchPlaceholder={t('common.search_users', 'Search users')}
                onAdd={handleAddMembers}
                isPending={shareDocument.isPending}
                renderItem={renderUserItem}
                isLoadingMore={isFetching}
                showButtonBadge={false}
              />
            ) : (
              <Button
                className="organization-members-add-button"
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

      {/* Members List */}
      <Stack
        className="organization-members-list-container"
        flexGrow={1}
        sx={{ overflow: 'auto' }}
        gap="10px"
        ml={{ xs: 0, sm: '20px' }}
        pr={{ xs: 0, sm: '16px' }}
      >
        <Box
          className="organization-members-list-header"
          sx={{
            display: { xs: 'none', sm: 'grid' },
            gridTemplateColumns: '2fr 1fr 1fr',
            borderBottom: '1px solid',
            borderColor: 'divider',
            color: 'divider',
            fontSize: '14px',
            lineHeight: '14px',
            pb: '17px',
            pl: { xs: '8px', sm: '24px' },
            pr: { xs: '8px', sm: '24px' },
          }}
        >
          <Box className="organization-members-list-header-user">User</Box>
          <Box
            className="organization-members-list-header-credits"
            display="flex"
            justifyContent="center"
            alignItems="center"
            sx={{ whiteSpace: 'nowrap' }}
          >
            Credits
          </Box>
        </Box>
        {filteredUsers.map(user => (
          <Fragment key={user.id}>
            <OrganizationUserCard organization={organization} user={user} userPermissions={userPermissions} />
          </Fragment>
        ))}
      </Stack>
    </Card>
  );
};

export default OrganizationMembers;
