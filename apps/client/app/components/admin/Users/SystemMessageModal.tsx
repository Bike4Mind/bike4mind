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
import {
  ADMIN_REASON_PRESETS,
  type AdminReasonDraft,
  EMPTY_ADMIN_REASON,
  composeAdminReason,
  isAdminReasonComplete,
} from '@client/app/components/admin/shared/adminReason';
import { ReasonPicker } from '@client/app/components/admin/shared/ReasonPicker';

interface SystemMessageModalProps {
  open: boolean;
  onClose: () => void;
  receiverId: string;
}

const SystemMessageModal: React.FC<SystemMessageModalProps> = ({ open, onClose, receiverId }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);
  const ready = !!title.trim() && !!message.trim() && isAdminReasonComplete(reason);

  const sendSystemMessage = useSendSystemMessage({
    onSuccess: () => {
      onClose();
      setTitle('');
      setMessage('');
      setReason(EMPTY_ADMIN_REASON);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;

    sendSystemMessage.mutate({
      title,
      message,
      receiverId,
      reason: composeAdminReason(reason),
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
        <form onSubmit={handleSubmit} data-testid="system-message-form">
          <Box mt={2} sx={{ display: 'grid', gap: '15px' }}>
            <FormControl required>
              <FormLabel>Title</FormLabel>
              <Input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Message Title"
                slotProps={{ input: { 'data-testid': 'system-message-title-input' } }}
              />
            </FormControl>
            <FormControl required>
              <FormLabel>Message</FormLabel>
              <Textarea
                minRows={4}
                size="lg"
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Enter your message here..."
                slotProps={{ textarea: { 'data-testid': 'system-message-body-input' } }}
              />
            </FormControl>
            <ReasonPicker
              presets={ADMIN_REASON_PRESETS.systemMessage}
              value={reason}
              onChange={setReason}
              data-testid="system-message-reason-input"
            />
          </Box>
          <Box mt="15px">
            <Button
              disabled={sendSystemMessage.isPending || !ready}
              type="submit"
              data-testid="system-message-send-btn"
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
