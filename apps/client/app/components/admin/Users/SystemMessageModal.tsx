import React, { useState } from 'react';
import {
  Modal,
  ModalClose,
  Sheet,
  Typography,
  Box,
  FormControl,
  FormLabel,
  Input,
  Textarea,
  Button,
  CircularProgress,
} from '@mui/joy';
import { useSendSystemMessage } from '@client/app/hooks/data/inbox';
import { useTranslation } from 'react-i18next';

interface SystemMessageModalProps {
  open: boolean;
  onClose: () => void;
  receiverId: string;
}

const SystemMessageModal: React.FC<SystemMessageModalProps> = ({ open, onClose, receiverId }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');

  const sendSystemMessage = useSendSystemMessage({
    onSuccess: () => {
      onClose();
      setTitle('');
      setMessage('');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !message.trim()) return;

    sendSystemMessage.mutate({
      title,
      message,
      receiverId,
    });
  };

  return (
    <Modal sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }} open={open} onClose={onClose}>
      <Sheet
        variant="outlined"
        sx={{
          minWidth: '400px',
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
        }}
      >
        <ModalClose />
        <Typography component="h2" level="h4">
          {t('Send System Message')}
        </Typography>
        <form onSubmit={handleSubmit}>
          <Box mt={2} sx={{ display: 'grid', gap: '15px' }}>
            <FormControl required>
              <FormLabel>Title</FormLabel>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Message Title" />
            </FormControl>
            <FormControl required>
              <FormLabel>Message</FormLabel>
              <Textarea
                minRows={4}
                size="lg"
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Enter your message here..."
              />
            </FormControl>
          </Box>
          <Box mt="15px">
            <Button
              disabled={sendSystemMessage.isPending || !title.trim() || !message.trim()}
              type="submit"
              sx={{ minWidth: '120px' }}
              variant="outlined"
              color="success"
            >
              {sendSystemMessage.isPending ? <CircularProgress size="sm" /> : 'Send'}
            </Button>
          </Box>
        </form>
      </Sheet>
    </Modal>
  );
};

export default SystemMessageModal;
