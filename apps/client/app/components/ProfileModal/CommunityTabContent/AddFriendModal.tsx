import { useSendFriendRequest } from '@client/app/hooks/data/friends';
import { useGetActivities } from '@client/app/hooks/data/activities';
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Textarea,
  Typography,
} from '@mui/joy';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';

export const useAddFriendModal = create<{
  isOpen: boolean;
  prefillEmail?: string;
  prefillMessage?: string;
  open: () => void;
  openWithPrefill: (email?: string, message?: string) => void;
  close: () => void;
  clearPrefill: () => void;
}>(set => ({
  isOpen: false,
  prefillEmail: undefined,
  prefillMessage: undefined,
  open: () => set({ isOpen: true }),
  openWithPrefill: (email, message) => set({ isOpen: true, prefillEmail: email, prefillMessage: message }),
  close: () => set({ isOpen: false }),
  clearPrefill: () => set({ prefillEmail: undefined, prefillMessage: undefined }),
}));

const AddFriendModal = () => {
  const { isOpen, close, prefillEmail, prefillMessage, clearPrefill } = useAddFriendModal();
  const sendFriendRequest = useSendFriendRequest();
  const activities = useGetActivities();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const { t } = useTranslation();

  useEffect(() => {
    if (isOpen) {
      if (prefillEmail) setEmail(prefillEmail);
      if (prefillMessage) setMessage(prefillMessage);
    }
  }, [isOpen, prefillEmail, prefillMessage]);

  const handleClose = () => {
    setEmail('');
    setMessage('');
    clearPrefill();
    close();
  };

  return (
    <Modal open={isOpen} onClose={handleClose}>
      <ModalDialog sx={{ gap: '30px', width: '100%' }} maxWidth="460px">
        <ModalClose />

        <Typography level="h4" fontWeight="normal">
          {t('add_friend.title')}
        </Typography>

        <FormControl>
          <FormLabel>{t('add_friend.friend_email')}</FormLabel>

          <Input
            placeholder={t('add_friend.email_placeholder')}
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </FormControl>

        <FormControl>
          <FormLabel>{t('add_friend.message')}</FormLabel>

          <Textarea
            placeholder={t('add_friend.message_placeholder')}
            minRows={4}
            value={message}
            onChange={e => setMessage(e.target.value)}
          />
        </FormControl>

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
          <Button variant="outlined" color="neutral" onClick={handleClose}>
            {t('add_friend.cancel')}
          </Button>

          <Button
            loading={sendFriendRequest.isPending}
            onClick={() => {
              sendFriendRequest.mutate(
                { email, message },
                {
                  onSuccess: () => {
                    close();
                    clearPrefill();
                    setEmail('');
                    setMessage('');
                    activities.refetch();
                  },
                }
              );
            }}
          >
            {t('add_friend.title')}
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};
export default AddFriendModal;
