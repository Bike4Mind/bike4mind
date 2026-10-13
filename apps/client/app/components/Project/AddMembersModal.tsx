import { grantablePermissions, heldPermissions, InviteType, IProjectDocument, Permission } from '@bike4mind/common';
import { FC, useState, useCallback, useMemo } from 'react';
import { useShareDocument } from '@client/app/hooks/data/invites';
import { useGetUsers } from '@client/app/hooks/data/user';
import { useUser } from '@client/app/contexts/UserContext';
import { IGetUsersParams } from '@client/app/utils/userAPICalls';
import AddIcon from '@mui/icons-material/Add';
import { useQueryClient } from '@tanstack/react-query';
import { debounce } from 'lodash';
import { useTranslation } from 'react-i18next';
import GenericAddItemsModal from './GenericAddItemsModal';
import UserCard from '../common/UserCard';
import { toast } from 'sonner';
import { Box, Button, Typography } from '@mui/joy';
import { z } from 'zod';

const isEmailAddress = (value: string) => z.email().safeParse(value).success;

const ProjectAddMembersModal: FC<{ project: IProjectDocument; ownerId: string; pendingInvites?: string[] }> = ({
  project,
  ownerId,
  pendingInvites = [],
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const { currentUser } = useUser();
  const userGroups = useMemo(() => currentUser?.groups ?? [], [currentUser?.groups]);

  // Same rule the server applies to minting a project invite and to the picker's pendingInvite
  // flag (shareable.findShareAccessById): owner, users[].share, or groups[].share.
  const canShare = heldPermissions(project, ownerId, userGroups).has(Permission.share);

  const params: IGetUsersParams = useMemo(
    () => ({ search, page: 1, limit: 10, publicView: true, pendingInviteProjectId: project.id }),
    [search, project.id]
  );
  const { data, isFetching } = useGetUsers(params, { enabled: canShare && search.length >= 3 });

  // createInvite refuses a grant the inviter does not hold, so a share-holder without update
  // invites with read only rather than failing outright.
  const permissions = useMemo(() => {
    const grantable = grantablePermissions(project, ownerId, userGroups);
    return [Permission.read, Permission.update].filter(permission => grantable.has(permission));
  }, [project, ownerId, userGroups]);

  const shareDocument = useShareDocument({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', 'projects', project.id] });
      setSearch('');
      setSelectedUserIds([]);
      toast.success('Sent an invite to the selected users');
    },
    onError: err => {
      toast.error(err.message);
    },
  });

  // A typed address that matched nobody becomes a project invite addressed to that email. Offered
  // only once the exact-email lookup for that same term has come back empty, so it says nothing
  // beyond what that lookup already said.
  const inviteByEmail = useShareDocument({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', 'projects', project.id] });
    },
    onError: err => {
      toast.error(err.message);
    },
  });

  const handleInviteByEmail = useCallback(
    (email: string) => {
      inviteByEmail.mutate(
        {
          description: `You've been invited to join the project`,
          recipients: [email],
          id: project.id,
          type: InviteType.Project,
          permissions,
        },
        {
          onSuccess: () =>
            toast.success(t('projects.modals.members.invite_sent', 'Invitation sent to {{email}}', { email })),
        }
      );
    },
    [inviteByEmail, project.id, permissions, t]
  );

  const renderNoResults = useCallback(
    (term: string) => {
      const email = term.trim().toLowerCase();
      const canInvite =
        term === search && !isFetching && isEmailAddress(email) && email !== currentUser?.email?.toLowerCase();
      return (
        <Box display="flex" flexDirection="column" alignItems="center" gap={2}>
          <Typography level="body-lg" color="neutral" textAlign="center">
            {t(
              'projects.modals.members.no_results',
              'No one matches that. Enter their full email address to invite them.'
            )}
          </Typography>
          {canInvite && (
            <Button
              data-testid="project-invite-by-email-btn"
              loading={inviteByEmail.isPending}
              onClick={() => handleInviteByEmail(email)}
              sx={{ overflowWrap: 'anywhere' }}
            >
              {t('projects.modals.members.invite_by_email', 'Invite {{email}} by email', { email })}
            </Button>
          )}
        </Box>
      );
    },
    [search, isFetching, currentUser?.email, inviteByEmail.isPending, handleInviteByEmail, t]
  );

  const users = useMemo(() => (data?.users ?? []).filter(u => u.id !== ownerId), [data?.users, ownerId]);
  const debouncedSearch = useMemo(() => debounce(setSearch, 300), []);

  const handleAddMembers = useCallback(
    (selectedUserIds: string[]) => {
      selectedUserIds.forEach(id => {
        shareDocument.mutate({
          description: `You've been invited to join the project`,
          recipients: [id],
          id: project.id,
          type: InviteType.Project,
          permissions,
        });
      });
    },
    [project.id, permissions, shareDocument]
  );

  const alreadyInvitedUsers = useMemo(() => {
    const userMap = new Map<string, 'accepted' | 'pending'>();
    project.users.forEach(member => userMap.set(member.userId, 'accepted'));
    pendingInvites.forEach(userId => userMap.set(userId, 'pending'));
    return userMap;
  }, [project.users, pendingInvites]);

  const getInviteStatus = useCallback(
    (user: any) => {
      return (
        alreadyInvitedUsers.get(user.id) ||
        (user.pendingInvite ? 'pending' : undefined) ||
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
          hideEmail={!user.email}
        />
      );
    },
    [getInviteStatus]
  );

  if (!canShare) {
    return null;
  }

  return (
    <GenericAddItemsModal
      title={t('projects.modals.members.title', 'Add Members to Project')}
      subtitle={t('projects.modals.members.subtitle', 'Invite people to collaborate on this project')}
      buttonLabel={t('projects.modals.members.button_label', 'Add Members')}
      buttonIcon={<AddIcon />}
      items={users}
      selectedIds={selectedUserIds}
      onSelectIds={setSelectedUserIds}
      getItemId={user => user.id}
      onSearch={term => debouncedSearch(term)}
      searchPlaceholder={t('projects.modals.members.search_placeholder', "Enter your teammate's full email address")}
      searchMinLength={3}
      onAdd={handleAddMembers}
      isPending={shareDocument.isPending}
      renderItem={renderUserItem}
      isLoadingMore={isFetching}
      showButtonBadge={false}
      emptyResultMessage={t('projects.modals.members.no_members')}
      renderNoResults={renderNoResults}
      getAddLabel={count => t('projects.modals.members.add_members', { count })}
      triggerTestId="project-add-members-btn"
    />
  );
};

export default ProjectAddMembersModal;
