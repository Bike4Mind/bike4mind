import { InviteType, IProjectDocument } from '@bike4mind/common';
import { useDeleteInvite, useGetProjectInvites } from '@client/app/hooks/data/invites';
import { useLeaveProject } from '@client/app/hooks/data/projects';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useGetUsers, useUserRevokeSharing } from '@client/app/hooks/data/user';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';
import { Box, CircularProgress, Stack, Typography, IconButton, Tooltip } from '@mui/joy';
import { redAlpha, red, brandAlpha } from '@client/app/utils/themes/colors';
import { useQueryClient } from '@tanstack/react-query';
import { debounce } from 'lodash';
import { useNavigate } from '@tanstack/react-router';
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import AddMembersModal from './AddMembersModal';
import UserCard from './UserCard';
import { SubscriptionCallbackFunction } from '@client/app/hooks/useCollection';
import { toast } from 'sonner';
import { updateAllQueryData, useSubscribeCollection } from '@client/app/utils/react-query';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useCoalescedInvalidate } from '@client/app/hooks/useCoalescedInvalidate';
import { useInviteEvents } from '@client/app/contexts/InboxContext';
import SearchBar from '@client/app/components/Session/SearchBar';
import LogoutIcon from '@mui/icons-material/Logout';

// Chat in a project bills the member who sends (or the organization they pick), never the project
// owner - see payerNoteText in components/Session/CreditPayerNote.tsx.
export const PROJECT_MEMBERS_BILLING_NOTE =
  'Each member pays for their own answers in this project, from their balance or their selected organization, not the project owner.';

// An entry the viewer did not type comes back as a user id named in recipientUsers (or a masked
// address), so show the name where there is one.
const pendingRecipientLabel = (invite: ISharerInviteView) => {
  const names = new Map((invite.recipientUsers ?? []).map(user => [user.userId, user.name]));
  return (invite.recipients?.pending ?? []).map(entry => names.get(entry) ?? entry).join(',');
};

const ProjectMembersSection: FC<{ project: IProjectDocument; ownerId: string }> = ({ project, ownerId }) => {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const confirm = useConfirmation();
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const getProjectInvites = useGetProjectInvites(
    { projectId: project.id, limit: 10, page: 1, statuses: 'pending' },
    { enabled: !!project.id && project.userId === ownerId, refetchOnMount: 'always' }
  );
  const queryClient = useQueryClient();
  const getUserKey = useMemo(() => ['users', 'projects', project.id, search], [project.id, search]);
  const getUsers = useGetUsers(
    { projectId: project.id, limit: 10, page: 1, publicView: true, search },
    { enabled: !!project.id, queryKey: getUserKey, refetchOnMount: 'always' }
  );
  const { mutate: revokeAccess } = useUserRevokeSharing({
    onSuccess: () => {
      getUsers.refetch();
      toast.success('Access revoked successfully');
    },
  });
  const deleteInvite = useDeleteInvite({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', 'projects', project.id] });
      toast.success('Invite successfully deleted');
    },
  });
  const leaveProject = useLeaveProject({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects', 'search'] });
      toast.success('You have left the project');
      navigate({ to: '/projects' });
    },
  });
  const pendingInvites = useMemo(
    () => (getProjectInvites.data?.data || []).filter(p => p.remaining > 0),
    [getProjectInvites.data]
  );
  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
      }, 300),
    []
  );

  useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

  const filteredPendingInvites = useMemo(() => {
    if (!search) return pendingInvites;

    return pendingInvites.filter(invite => pendingRecipientLabel(invite).toLowerCase().includes(search.toLowerCase()));
  }, [pendingInvites, search]);

  const debouncedInvalidateUsers = useMemo(() => {
    return debounce(() => queryClient.invalidateQueries({ queryKey: getUserKey }), 500);
  }, [queryClient, getUserKey]);

  useEffect(() => () => debouncedInvalidateUsers.cancel(), [debouncedInvalidateUsers]);

  const coalescedInvalidateInvites = useCoalescedInvalidate(['invites', 'projects', project.id]);

  // Listens to InboxProvider's single `invites` subscription instead of opening a second one.
  // Refetch rather than write the event's document: the subscription withholds `recipients`
  // (server/websocket/dataSubscribeFieldLimits.ts), and the REST list redacts them per viewer.
  useInviteEvents(
    (_type, data) => {
      if (data?.documentId !== project.id || data?.type !== InviteType.Project) return;
      coalescedInvalidateInvites();
      debouncedInvalidateUsers();
    },
    { projectId: project.id }
  );

  // Update the users list whenever the project changes
  useSubscribeCollection(
    'projects',
    useMemo(() => (project?.id ? { id: project.id } : null), [project.id]),
    useCallback<SubscriptionCallbackFunction<IProjectDocument>>(
      (type, data) => {
        // Every update: write it through to the cached projects, then refresh the dependent members and invites.
        if (type === 'update') {
          updateAllQueryData(queryClient, 'projects', 'write', data);
          debouncedInvalidateUsers();
          coalescedInvalidateInvites();
        }
      },
      [coalescedInvalidateInvites, debouncedInvalidateUsers, queryClient]
    )
  );

  return (
    <Stack gap="20px" sx={{ height: '100%' }} className="project-members-container">
      <Stack gap="12px" mx="20px" className="project-members-header">
        <Box
          sx={{
            flexDirection: {
              xs: 'column',
              sm: 'row',
            },
            display: 'flex',
            gap: '12px',
          }}
          className="project-members-controls"
        >
          <SearchBar
            handleChange={debouncedSearch}
            placeHolder="Search members"
            debounceTimeout={300}
            sx={theme => ({
              flexGrow: 1,
              color: theme.palette.searchbar.color,
              border: `1px solid ${theme.palette.border.input}`,
              background: theme.palette.searchbar.background,
              fontSize: '14px',
              fontWeight: 400,
              lineHeight: '100%',
              fontStyle: 'normal',
              borderRadius: '8px',
              boxShadow: `0px 1px 50px 0px ${brandAlpha[700][3]}`,
              '&:focus-within .MuiSvgIcon-root': {
                color: theme.palette.mode === 'dark' ? 'white' : 'black',
              },
            })}
            className="project-members-search"
          />
          <AddMembersModal
            project={project}
            ownerId={ownerId}
            pendingInvites={pendingInvites.map(i => i.recipients?.pending ?? []).flat()}
          />
          {project.userId !== ownerId && (
            <Tooltip title="Leave Project" className="project-members-leave-tooltip">
              <IconButton
                variant="outlined"
                className="project-members-leave-button"
                onClick={() =>
                  confirm({
                    type: 'danger',
                    title: 'Leave Project',
                    description: 'Are you sure you want to leave this project?',
                    onOk: () => leaveProject.mutateAsync({ projectId: project.id }),
                  })
                }
                disabled={leaveProject.isPending}
                sx={{
                  borderRadius: '8px',
                  width: 36,
                  height: 36,
                  minWidth: 36,
                  minHeight: 36,
                  maxWidth: 36,
                  maxHeight: 36,
                  p: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `1px solid ${redAlpha[325][50]}`,
                  color: red[325],
                  background: 'none',
                  boxShadow: 'none',
                  '&:hover': {
                    background: redAlpha[325][8],
                    boxShadow: 'none',
                    border: `1px solid ${redAlpha[325][50]}`,
                  },
                }}
              >
                {leaveProject.isPending ? (
                  <CircularProgress size="sm" className="project-members-leave-progress" />
                ) : (
                  <LogoutIcon sx={{ color: red[325], width: 20, height: 20 }} className="project-members-leave-icon" />
                )}
              </IconButton>
            </Tooltip>
          )}
        </Box>
        {enforceCredits && (
          <Typography data-testid="project-members-billing-note" level="body-xs" sx={{ color: 'text.tertiary' }}>
            {PROJECT_MEMBERS_BILLING_NOTE}
          </Typography>
        )}
      </Stack>
      <Stack flexGrow={1} sx={{ overflow: 'auto' }} gap="10px" ml="20px" pr="16px" className="project-members-list">
        {getUsers.isPending ? (
          <Box
            mb="100px"
            flexGrow={1}
            display="flex"
            justifyContent="center"
            alignItems="center"
            className="project-members-loading"
          >
            <CircularProgress className="project-members-loading-progress" />
          </Box>
        ) : (
          <Stack gap="10px" className="project-members-content">
            {filteredPendingInvites.length > 0 || (getUsers.data?.users || []).length > 0 ? (
              <>
                {filteredPendingInvites.map(invite => (
                  <UserCard
                    key={invite.id}
                    user={{
                      name: pendingRecipientLabel(invite),
                      email: pendingRecipientLabel(invite),
                      photoUrl: null,
                      id: invite.documentId,
                    }}
                    inviteStatus={'pending'}
                    onDelete={
                      project.userId === ownerId
                        ? () =>
                            deleteInvite.mutate({
                              id: invite.id,
                            })
                        : undefined
                    }
                    isDeleting={deleteInvite.isPending}
                  />
                ))}
                {(getUsers.data?.users || []).map(member => (
                  <UserCard
                    key={member.id}
                    user={{ ...member, id: member.id }}
                    onRevoke={
                      project.userId === ownerId
                        ? () => revokeAccess({ id: project.id, userId: member.id, type: InviteType.Project })
                        : undefined
                    }
                  />
                ))}
              </>
            ) : (
              <Box
                display="flex"
                justifyContent="center"
                alignItems="center"
                py={4}
                className="project-members-empty-state"
              >
                <Typography level="body-lg" color="neutral" className="project-members-empty-text">
                  No members found. {search ? 'Try adjusting your search.' : ''}
                </Typography>
              </Box>
            )}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
};

export default ProjectMembersSection;
