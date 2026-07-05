import React, { useMemo } from 'react';
import { Modal, ModalClose, Sheet, Box, Typography, Avatar, Button } from '@mui/joy';
import dayjs from 'dayjs';
import { getAppFileUrl } from '@client/app/utils/s3';
import AddFriendModal, {
  useAddFriendModal,
} from '@client/app/components/ProfileModal/CommunityTabContent/AddFriendModal';
import { useGetFriendshipByUserId } from '@client/app/hooks/data/friends';
import { FriendshipStatus } from '@bike4mind/common';

// Types for sender info shown in the modal
export type Sender = {
  id?: string;
  username?: string;
  name?: string;
  email?: string;
  photoUrl?: string | null;
  avatarKey?: string | null;
  createdAt?: string | number | Date;
  phone?: string | null;
};

export type SenderInfoModalProps = {
  open: boolean;
  onClose: () => void;
  sender?: Sender;
};

function getDisplayName(sender?: Sender): string {
  if (!sender) return 'Unknown User';
  if (sender.username && sender.username.trim()) return sender.username;
  if (sender.name && sender.name.trim()) return sender.name;
  if (sender.email && sender.email.trim()) return sender.email;
  return 'Unknown User';
}

export default function SenderInfoModal({ open, onClose, sender }: SenderInfoModalProps) {
  const { openWithPrefill } = useAddFriendModal();
  const friendship = useGetFriendshipByUserId(sender?.id);

  const avatarUrl = useMemo(() => {
    const key = sender?.photoUrl ?? sender?.avatarKey;
    if (!key) return undefined;
    try {
      return getAppFileUrl({ key });
    } catch {
      return undefined;
    }
  }, [sender?.photoUrl, sender?.avatarKey]);

  const joined = sender?.createdAt ? dayjs(sender.createdAt).format('MMM D, YYYY') : undefined;

  const handleAddFriendClick = () => {
    const email = sender?.email;
    const message = `Hi ${getDisplayName(sender)}, let's connect!`;
    openWithPrefill(email, message);
  };

  const isFriend = friendship.data?.status === FriendshipStatus.ACCEPTED;
  const showAddFriend = !!sender?.email && !isFriend;

  return (
    <>
      <Modal open={open} onClose={onClose} sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <Sheet
          variant="outlined"
          sx={{
            width: '616px',
            minWidth: '400px',
            maxWidth: '616px',
            borderRadius: 'md',
            p: 4,
            boxShadow: 'lg',
            backgroundColor: 'background.body',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <ModalClose />
          {/* Avatar */}
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1, mb: 1 }}>
            <Avatar
              alt={getDisplayName(sender)}
              src={avatarUrl}
              sx={{ width: 140, height: 140, borderRadius: '50%', boxShadow: 'sm' }}
            />
          </Box>

          {/* Header: title + meta */}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', mb: 1 }}>
            <Typography level="h4" sx={{ color: 'text.primary', fontWeight: 600 }}>
              Profile
            </Typography>
            {joined && (
              <Typography level="body-sm" sx={{ color: 'text.primary50' }}>
                Joined {joined}
              </Typography>
            )}
          </Box>

          {/* Divider */}
          <Box sx={{ borderBottom: '1px solid', borderBottomColor: 'inbox.border.light', mb: 1 }} />

          {/* Row: Name | Phone */}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 1 }}>
            <Typography sx={{ color: 'text.primary', fontWeight: 500 }}>{getDisplayName(sender)}</Typography>
            <Typography sx={{ color: 'text.primary50' }}>{sender?.phone || '—'}</Typography>
          </Box>
          <Box sx={{ borderBottom: '1px solid', borderBottomColor: 'inbox.border.light' }} />

          {/* Email row */}
          {sender?.email && (
            <Box sx={{ py: 1 }}>
              <Typography sx={{ color: 'text.primary50' }}>{sender.email}</Typography>
            </Box>
          )}
          <Box sx={{ borderBottom: '1px solid', borderBottomColor: 'inbox.border.light', mb: 1 }} />
          {showAddFriend && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
              <Button
                onClick={handleAddFriendClick}
                sx={{
                  px: 4,
                  py: 1.2,
                  borderRadius: 999,
                  color: '#fff',
                  boxShadow: 'md',
                  '&:hover': {
                    filter: 'brightness(0.95)',
                    boxShadow: 'lg',
                  },
                }}
              >
                Add Friend
              </Button>
            </Box>
          )}
        </Sheet>
      </Modal>

      {/* Mount the AddFriendModal so it can open via the shared store from anywhere this component is used */}
      <AddFriendModal />
    </>
  );
}
