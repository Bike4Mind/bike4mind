import { InviteType, IProjectDocument, Permission } from '@bike4mind/common';
import { FC, useState, useCallback, useMemo } from 'react';
import { useShareDocument } from '@client/app/hooks/data/invites';
import { useGetUsers } from '@client/app/hooks/data/user';
import { IGetUsersParams } from '@client/app/utils/userAPICalls';
import AddIcon from '@mui/icons-material/Add';
import { useQueryClient } from '@tanstack/react-query';
import { debounce } from 'lodash';
import { useTranslation } from 'react-i18next';
import GenericAddItemsModal from './GenericAddItemsModal';
import UserCard from '../common/UserCard';
import { toast } from 'sonner';

const ProjectAddMembersModal: FC<{ project: IProjectDocument; ownerId: string; pendingInvites?: string[] }> = ({
  project,
  ownerId,
  pendingInvites = [],
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [selectedUserNames, setSelectedUserNames] = useState<string[]>([]);
  const queryClient = useQueryClient();

  const params: IGetUsersParams = useMemo(() => ({ search, page: 1, limit: 10, publicView: true }), [search]);
  const { data, isFetching } = useGetUsers(params, { enabled: !!search });

  const [permissions] = useState<{ value: Permission[]; error?: string | null }>({
    value: [Permission.read, Permission.update],
    error: null,
  });

  const shareDocument = useShareDocument({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', 'projects', project.id] });
      setSearch('');
      setSelectedUserNames([]);
      toast.success('Sent an invite to the selected users');
    },
    onError: err => {
      toast.error(err.message);
    },
  });

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
          permissions: permissions.value,
        });
      });
    },
    [project.id, permissions.value, shareDocument]
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
        />
      );
    },
    [getInviteStatus]
  );

  // Only show the modal button if the current user is the owner
  if (ownerId !== project.userId) {
    return null;
  }

  return (
    <GenericAddItemsModal
      title={t('projects.modals.members.title', 'Add Members to Project')}
      subtitle={t('projects.modals.members.subtitle', 'Search for users to add to this project')}
      buttonLabel={t('projects.modals.members.button_label', 'Add Members')}
      buttonIcon={<AddIcon />}
      items={users}
      selectedIds={selectedUserNames}
      onSelectIds={setSelectedUserNames}
      getItemId={user => user.username}
      onSearch={term => debouncedSearch(term)}
      searchPlaceholder={t('common.search_users', 'Search users')}
      onAdd={handleAddMembers}
      isPending={shareDocument.isPending}
      renderItem={renderUserItem}
      isLoadingMore={isFetching}
      showButtonBadge={false}
      emptyResultMessage={t('projects.modals.members.no_members')}
      triggerTestId="project-add-members-btn"
    />
  );
};

export default ProjectAddMembersModal;
