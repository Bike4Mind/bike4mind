import { FriendshipStatus } from '@bike4mind/common';
import ProfileDetailSection from '@client/app/components/profile/ProfileDetailSection';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { useGetJoinedProjects } from '@client/app/hooks/data/projects';
import ProjectCard from '@client/app/components/Project/Card';
import { Grid } from '@mui/joy';
import { useGetFriendshipByUserId, useSendFriendRequest, useUnfriend } from '@client/app/hooks/data/friends';
import { useGetUser } from '@client/app/hooks/data/user';
import { Box, Button, LinearProgress } from '@mui/joy';
import PersonRemoveIcon from '@mui/icons-material/PersonRemove';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { ProfileEvents } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useEffect, useState } from 'react';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const ProfilePage = () => {
  const [hasLogged, setHasLogged] = useState<boolean>(false);
  const { id } = useParams({ strict: false });
  const user = useGetUser(id!);
  const friendship = useGetFriendshipByUserId(id!);
  const unfriend = useUnfriend();
  const sendFriendRequest = useSendFriendRequest();
  const { t } = useTranslation();
  const joinedProjects = useGetJoinedProjects(id!);
  const logEvent = useLogEvent();
  const { currentUser } = useUser();

  useEffect(() => {
    // Don't log a profile view for missing IDs or when viewing your own profile.
    if (id && currentUser?.id && id !== currentUser.id && !hasLogged) {
      logEvent.mutate({
        type: ProfileEvents.PROFILE_VIEW,
        metadata: {
          viewedProfileId: id,
          viewerId: currentUser.id,
        },
      });
      setHasLogged(true);
    }
  }, [id, currentUser?.id, hasLogged, logEvent]);

  const profileName = user.data?.name || user.data?.username;
  useDocumentTitle(profileName ? `${profileName}'s Profile` : 'Profile');

  const handleAddFriend = (): void => {
    if (!user.data?.email) return;
    sendFriendRequest.mutate({ email: user.data.email });
  };

  const handleUnfriend = (): void => {
    if (!friendship.data?.id) return;
    unfriend.mutate(friendship.data.id);
  };

  // Early return if no id yet (during initial routing)
  if (!id) {
    return <LinearProgress />;
  }

  return (
    <>
      {user.isPending || user.isLoading ? (
        <LinearProgress />
      ) : (
        <Box sx={{ padding: '30px', height: '100%', overflow: 'auto' }}>
          <Box sx={{ maxWidth: '1375px', margin: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <ProfileDetailSection
              userId={id}
              canEdit={currentUser?.id === id}
              email={user.data?.email ?? undefined}
              extra={
                <>
                  {friendship.isPending ? null : (
                    <>
                      {!friendship.data ? (
                        <Button
                          size="sm"
                          startDecorator={<PersonAddIcon />}
                          onClick={handleAddFriend}
                          loading={sendFriendRequest.isPending}
                          disabled={!user.data?.email}
                        >
                          {t('friends.add_friend')}
                        </Button>
                      ) : friendship.data.status === FriendshipStatus.ACCEPTED ? (
                        <Button
                          size="sm"
                          color="danger"
                          startDecorator={<PersonRemoveIcon />}
                          onClick={handleUnfriend}
                          loading={unfriend.isPending}
                        >
                          {t('friends.unfriend')}
                        </Button>
                      ) : friendship.data.status === FriendshipStatus.PENDING ? (
                        <Button
                          size="sm"
                          color="warning"
                          startDecorator={<PersonRemoveIcon />}
                          onClick={handleUnfriend}
                          loading={unfriend.isPending}
                        >
                          {t('friends.pending_request')}
                        </Button>
                      ) : null}
                    </>
                  )}
                </>
              }
            />

            <SectionContainer title={t('projects.joined_projects')}>
              {(() => {
                if (joinedProjects.isPending) {
                  return (
                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                      <LinearProgress />
                    </Box>
                  );
                }

                if (!joinedProjects.data?.length) {
                  return (
                    <Box sx={{ textAlign: 'center', color: 'neutral.500', p: 2 }}>
                      {t('projects.no_joined_projects')}
                    </Box>
                  );
                }

                return (
                  <Grid container spacing={2} sx={{ p: 2 }}>
                    {joinedProjects.data.map(project => (
                      <Grid key={project.id} xs={12} sm={6} md={4} lg={3}>
                        <ProjectCard project={project} />
                      </Grid>
                    ))}
                  </Grid>
                );
              })()}
            </SectionContainer>
          </Box>
        </Box>
      )}
    </>
  );
};

export default ProfilePage;
