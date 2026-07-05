import { useState } from 'react';
import { useAddFriendModal } from '@client/app/components/ProfileModal/CommunityTabContent/AddFriendModal';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { useUser } from '@client/app/contexts/UserContext';
import { useRespondToFriendRequest, useUnfriend } from '@client/app/hooks/data/friends';
import { useGetFriendRequests, useGetFriends } from '@client/app/hooks/data/user';
import { getAppFileUrl } from '@client/app/utils/s3';
import {
  Avatar,
  Badge,
  Box,
  Dropdown,
  IconButton,
  LinearProgress,
  Menu,
  MenuButton,
  MenuItem,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Typography,
} from '@mui/joy';
import CheckIcon from '@mui/icons-material/Check';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PersonAddAltIcon from '@mui/icons-material/PersonAddAlt';
import CloseIcon from '@mui/icons-material/Close';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import SearchBar from '@client/app/components/Session/SearchBar';
import { brandAlpha, green } from '@client/app/utils/themes/colors';

enum FriendsTab {
  AllFriends,
  Pending,
}

const FriendsSection = () => {
  const openAddFriendModal = useAddFriendModal(state => state.open);
  const { currentUser } = useUser();
  const friends = useGetFriends(currentUser?.id);
  const friendRequests = useGetFriendRequests(currentUser?.id);
  const { t } = useTranslation();

  const [searchQuery, setSearchQuery] = useState('');

  const filteredFriends = friends.data?.filter(friend =>
    friend.user?.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <SectionContainer>
      <Tabs sx={{ backgroundColor: 'transparent' }}>
        <TabList tabFlex={1}>
          <Tab value={FriendsTab.AllFriends} sx={{ flex: 1 }}>
            {t('friends.all')}
          </Tab>
          <Badge size="sm" color="danger" invisible={friendRequests.data?.length === 0} sx={{ flex: 1 }}>
            <Tab value={FriendsTab.Pending}>
              <span>{t('friends.pending')}</span>
              {friendRequests.data && friendRequests.data.length > 0 && (
                <Box
                  sx={theme => ({
                    padding: '3px',
                    backgroundColor: brandAlpha[800][50],
                    borderRadius: '3px',
                    fontSize: theme.fontSize.sm,
                    width: '28px',
                    textAlign: 'center',
                  })}
                >
                  {friendRequests.data.length}
                </Box>
              )}
            </Tab>
          </Badge>
        </TabList>

        <TabPanel
          value={FriendsTab.AllFriends}
          sx={{
            paddingTop: '1.25rem',
            borderRadius: '8px',
            backgroundColor: 'primary.softBg',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
          }}
        >
          <Box sx={{ display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
            <SearchBar
              handleChange={setSearchQuery}
              placeHolder={t('search')}
              debounceTimeout={300}
              sx={theme => ({
                boxShadow: 'none',
                border: `1px solid ${theme.palette.border.input}`,
                background: theme.palette.searchbar.background,
                flex: 1,
              })}
            />

            <IconButton
              color="primary"
              variant="solid"
              onClick={openAddFriendModal}
              size="sm"
              sx={{ height: 'calc(100% - 5px)' }}
            >
              <PersonAddAltIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Box>

          {friends.isPending && <LinearProgress />}

          {!friends.isPending && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {!filteredFriends?.length ? (
                <Typography level="body-sm" sx={{ textAlign: 'center' }}>
                  {!friends.data?.length ? (
                    <>
                      No friends yet. <br />
                      Add some friends to get started!
                    </>
                  ) : (
                    'No friends found matching your search'
                  )}
                </Typography>
              ) : (
                filteredFriends?.map(friend => (
                  <FriendRow
                    key={friend.id}
                    name={friend.user.name}
                    userId={friend.user.id}
                    id={friend.id}
                    isOnline={!!friend.user.isOnline}
                    photoUrl={friend.user.photoUrl}
                  />
                ))
              )}
            </Box>
          )}
        </TabPanel>

        <TabPanel value={FriendsTab.Pending}>
          {friendRequests.isPending && <LinearProgress />}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {friendRequests.data?.length === 0 ? (
              <Typography level="body-sm" sx={{ textAlign: 'center' }}>
                No pending friend requests.
              </Typography>
            ) : (
              friendRequests.data?.map(request => (
                <PendingRow
                  key={request.id}
                  id={request.id}
                  name={request.user.name}
                  photoUrl={request.user.photoUrl}
                />
              ))
            )}
          </Box>
        </TabPanel>
      </Tabs>
    </SectionContainer>
  );
};

export const PendingRow = ({ id, name, photoUrl }: { id: string; name: string; photoUrl?: string | null }) => {
  const respondToFriendRequest = useRespondToFriendRequest();

  const avatarUrl = photoUrl ? getAppFileUrl({ key: photoUrl }) : '';

  return (
    <Box
      sx={{
        backgroundColor: 'background.body',
        padding: '0.938rem',
        borderRadius: '10px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <Box sx={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <Avatar size="sm" src={avatarUrl} />

        <Typography level="body-sm">{name}</Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: '12px' }}>
        <IconButton
          color="danger"
          variant="solid"
          onClick={() => respondToFriendRequest.mutate({ id, accept: false })}
          loading={respondToFriendRequest.isPending}
        >
          <CloseIcon />
        </IconButton>
        <IconButton
          color="success"
          variant="solid"
          onClick={() => respondToFriendRequest.mutate({ id, accept: true })}
          loading={respondToFriendRequest.isPending}
        >
          <CheckIcon />
        </IconButton>
      </Box>
    </Box>
  );
};

interface FriendRowProps {
  /** The ID of the friendship document */
  id: string;
  /** User ID of the friend */
  userId: string;
  name: string;
  isOnline: boolean;
  photoUrl?: string | null;
}

export const FriendRow = ({ id, userId, name, isOnline, photoUrl }: FriendRowProps) => {
  const unfriend = useUnfriend();
  const navigate = useNavigate();
  const avatarUrl = photoUrl ? getAppFileUrl({ key: photoUrl }) : '';

  const handleCheckProfile = () => {
    navigate({ to: `/profile/${userId}` });
  };

  return (
    <Box
      sx={{
        backgroundColor: 'background.body',
        padding: '0.938rem',
        borderRadius: '10px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        border: theme => theme.palette.profile.border,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
        }}
      >
        <Avatar size="sm" src={avatarUrl} />

        <Box>
          <Typography level="body-sm">{name}</Typography>
          <Typography
            level="body-sm"
            textColor={isOnline ? green[800] : undefined}
            sx={{ opacity: isOnline ? undefined : '50%' }}
          >
            {isOnline ? 'Online' : 'Offline'}
          </Typography>
        </Box>
      </Box>

      <Dropdown>
        <MenuButton slots={{ root: IconButton }} loading={unfriend.isPending}>
          <MoreVertIcon />
        </MenuButton>

        <Menu sx={{ zIndex: 1300 }}>
          <MenuItem onClick={handleCheckProfile}>Check Profile</MenuItem>
          <MenuItem disabled>Message</MenuItem>
          <MenuItem disabled>Invite to a Project</MenuItem>
          <MenuItem
            onClick={() => {
              unfriend.mutate(id);
            }}
            disabled={unfriend.isPending}
          >
            Remove from friends
          </MenuItem>
        </Menu>
      </Dropdown>
    </Box>
  );
};

export default FriendsSection;
