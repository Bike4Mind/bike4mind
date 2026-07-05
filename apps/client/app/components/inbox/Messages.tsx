import { useUser } from '@client/app/contexts/UserContext';
import { useGetInbox, useReadInboxItems, useSendInboxitem, useDeleteInbox } from '@client/app/hooks/data/inbox';
import { IInboxDocument } from '@bike4mind/common';
import SentimentSatisfiedIcon from '@mui/icons-material/SentimentSatisfied';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import AddIcon from '@mui/icons-material/Add';
import {
  Avatar,
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  List,
  Modal,
  ModalClose,
  Sheet,
  Textarea,
  Typography,
  Link,
} from '@mui/joy';
import React, { FormEvent, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@mui/joy/styles';
import { getAppFileUrl } from '@client/app/utils/s3';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { toast } from 'sonner';
import { red, blue, gray } from '@client/app/utils/themes/colors';
import dayjs from 'dayjs';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import SenderInfoModal from './SenderInfoModal';

// Helper function for consistent sender name logic
const getSenderName = (userId: string, sender: any) => {
  if (userId === 'SYSTEM') return 'SYSTEM';
  if (sender?.username) return sender.username;
  if (sender?.name) return sender.name;
  return 'Unknown User';
};

const inputStyle = {
  border: '1px solid',
  borderColor: 'border.light',
  backgroundColor: 'inbox.backgroundColor.textInput',
  mb: '8px',
  '& input::placeholder': {
    color: 'text.primary50',
    fontWeight: '400',
    fontSize: '14px',
  },
  '& input': {
    color: 'text.primary',
    fontSize: '14px',
    fontWeight: '400',
  },
};

const labelStyle = {
  color: 'text.primary50',
  fontSize: '14px',
  fontWeight: '400',
  mb: '4px',
};

const blueButtonStyle = {
  minWidth: '140px',
  height: '32px !important',
  minHeight: '32px !important',
  color: gray[200],
  borderRadius: '8px',
  fontWeight: '400',
  fontSize: '14px',
};

const Messages: React.FC = () => {
  const userId = useUser(useShallow(s => s.currentUser?.id));
  const [openSend, setOpenSend] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [selectedInbox, setSelectedInbox] = useState<IInboxDocument | null>(null);
  const [messageValue, setMessageValue] = useState('');
  const { data: inbox, isLoading: inboxLoading } = useGetInbox(userId || null);
  const { t } = useTranslation();
  const theme = useTheme();

  const { mutate: readInbox } = useReadInboxItems();
  const { mutate: sendMessage } = useSendInboxitem({
    onSuccess: () => {
      setSendLoading(false);
      setOpenSend(false);
      setShowReplyInput(false);
      setReplyMessage('');
      setMessageValue('');
    },
    onSettled: () => setSendLoading(false),
  });
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);

  const deleteInboxMutation = useDeleteInbox({
    onSettled: () => {
      setShowDeleteModal(false);
      // Clear selection state if the opened item was deleted
      if (selectedInbox && deleteItemId && selectedInbox.id === deleteItemId) {
        setSelectedInbox(null);
        setSelectedSender(null);
      }
      setDeleteItemId(null);
    },
  });
  const [selectedSender, setSelectedSender] = useState<any>(null);
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyMessage, setReplyMessage] = useState('');

  const handleOpenInboxItem = (inboxItem: IInboxDocument) => {
    const sender = (inboxItem as any).sender;
    setSelectedInbox(inboxItem);
    setSelectedSender(sender);
  };

  const handleCloseInboxItem = (inboxItem: IInboxDocument) => {
    const id = inboxItem.id;
    const readAt = inboxItem?.readAt;

    setSelectedInbox(null);
    setSelectedSender(null);
    if (readAt) return;
    readInbox([id]);
  };

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    setSendLoading(true);
    const form = e.target as HTMLFormElement;
    const receiver = form.receiver.value;
    const title = form.ttle.value;
    const message = form.message.value;

    try {
      sendMessage({ receiver, title, message });
      // Form will be cleared in the onSuccess callback
    } catch {
      console.log('Failed to send message');
    }
  };

  const openDeleteForItem = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeleteItemId(id);
    setShowDeleteModal(true);
  };

  const handleReply = () => {
    setShowReplyInput(true);
  };

  const handleReplySubmit = async () => {
    if (!selectedInbox || !selectedSender || !replyMessage.trim()) return;

    setSendLoading(true);
    const replyTitle = `Re: ${selectedInbox.title}`;
    const receiver = selectedSender.username || selectedSender.email;

    try {
      sendMessage({
        receiver,
        title: replyTitle,
        message: replyMessage,
      });
    } catch {
      toast.error('Failed to send reply');
    }
  };

  const handleReplyCancel = () => {
    setShowReplyInput(false);
    setReplyMessage('');
  };

  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const peopleCount = useMemo(() => {
    if (!inbox) return 0;
    const set = new Set((inbox || []).filter(i => i.userId !== 'SYSTEM').map(i => i.userId));
    return set.size;
  }, [inbox]);

  const filteredInbox = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = (inbox || []).filter(item => {
      if (item.userId !== 'SYSTEM' && !(item as any).sender) return false;
      if (!q) return true;
      const sender = (item as any).sender;
      const senderName = getSenderName(item.userId, sender).toLowerCase();
      return (
        senderName.includes(q) ||
        (item.title || '').toLowerCase().includes(q) ||
        (item.message || '').toLowerCase().includes(q)
      );
    });
    return list.sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
  }, [inbox, searchQuery]);

  const formatTime = (date: Date) => dayjs(date).format('HH:mm');

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        flex: 1,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Box sx={{ px: 1, pt: 1.5, pb: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography sx={{ fontSize: '13px', color: 'text.primary50', mt: 0.5 }}>
            {peopleCount} person · {inbox?.length || 0} messages
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <IconButton variant="plain" color="neutral" onClick={() => setShowSearch(v => !v)}>
            <SearchRoundedIcon />
          </IconButton>
          <IconButton variant="plain" color="primary" onClick={() => setOpenSend(true)}>
            <AddIcon />
          </IconButton>
        </Box>
      </Box>

      {showSearch && (
        <Box sx={{ px: 1, pb: 1 }}>
          <Input
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            placeholder="Search messages"
            startDecorator={<SearchRoundedIcon />}
            sx={{ borderRadius: '10px' }}
          />
        </Box>
      )}

      {/* Removed item-level loading bar */}

      {/* No Messages Placeholder */}
      {inbox?.length === 0 && (
        <Box
          mt={'20px'}
          width={'100%'}
          display={'flex'}
          justifyContent={'center'}
          alignItems={'center'}
          flexDirection={'column'}
          flex={1}
          height={'100%'}
        >
          <SentimentSatisfiedIcon sx={{ fontSize: '130px', color: 'inbox.text.placeholder' }} />
          <Typography sx={{ fontSize: '16px', color: 'inbox.text.placeholder' }}>{t('inbox.noMessages')}</Typography>
        </Box>
      )}

      {/* Loading Indicator if inbox is loading */}
      {inboxLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1, height: '100%' }}>
          <CircularProgress />
        </Box>
      )}

      {/* Messages List */}
      {filteredInbox && filteredInbox.length > 0 && !inboxLoading && (
        <Box
          sx={{
            flex: filteredInbox.length > 0 ? 1 : 0,
            height: '100%',
            overflow: 'auto',
            px: 1,
            '&::-webkit-scrollbar': {
              display: 'none',
            },
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          <List sx={{ py: 0 }}>
            {filteredInbox.map((item, idx) => {
              const sender = (item as any).sender;
              const senderName = getSenderName(item?.userId, sender);
              const avatarUrl = sender?.photoUrl ? getAppFileUrl({ key: sender?.photoUrl }) : '';
              const isUnread = !item.readAt;

              if (item.userId !== 'SYSTEM' && !sender) {
                return null;
              }

              return (
                <Box
                  key={item.id}
                  onClick={() => handleOpenInboxItem(item)}
                  sx={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    py: 1.5,
                    borderBottom: idx === filteredInbox.length - 1 ? 'none' : '1px solid',
                    borderBottomColor: 'inbox.border.light',
                    cursor: 'pointer',
                    '&:hover': {
                      backgroundColor: 'background.level1',
                    },
                  }}
                >
                  {/* Avatar with unread dot */}
                  <Box sx={{ position: 'relative' }}>
                    <Avatar sx={{ width: '36px', height: '36px' }} src={avatarUrl}>
                      {senderName?.[0] || 'U'}
                    </Avatar>
                    {isUnread && (
                      <Box
                        sx={{
                          position: 'absolute',
                          top: -1,
                          left: -1,
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: 'warning.500',
                          boxShadow: `0 0 0 2px ${theme.vars.palette.background.body}`,
                        }}
                      />
                    )}
                  </Box>

                  {/* Message Content */}
                  <Box flex={1} minWidth={0} sx={{ pr: '88px' }}>
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                      <Typography
                        sx={{
                          fontWeight: 500,
                          fontSize: '16px',
                          color: 'text.primary',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {senderName}
                      </Typography>
                    </Box>

                    <Typography
                      sx={{ position: 'absolute', right: '8px', top: '8px', fontSize: '12px', color: 'text.primary50' }}
                    >
                      {formatTime(item.createdAt)}
                    </Typography>

                    <Typography
                      sx={{
                        fontWeight: '400',
                        fontSize: '14px',
                        color: 'text.primary',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </Typography>

                    <Typography
                      sx={{
                        fontSize: '13px',
                        color: 'text.primary50',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.message}
                    </Typography>
                  </Box>

                  {/* Per-item delete button */}
                  <IconButton
                    aria-label="Delete message"
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={e => openDeleteForItem(e, item.id)}
                    sx={{ position: 'absolute', right: '8px', bottom: '8px' }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Box>
              );
            })}
          </List>
        </Box>
      )}

      {selectedInbox && (
        <InboxDisplayModal
          open={!!selectedInbox}
          inbox={selectedInbox}
          sender={selectedSender}
          onClose={() => handleCloseInboxItem(selectedInbox)}
          onReply={handleReply}
          showReplyInput={showReplyInput}
          replyMessage={replyMessage}
          onReplyMessageChange={setReplyMessage}
          onReplySubmit={handleReplySubmit}
          onReplyCancel={handleReplyCancel}
          sendLoading={sendLoading}
        />
      )}

      {userId && (
        <InboxCreateModal
          open={openSend}
          onClose={() => setOpenSend(false)}
          onSubmit={handleSendMessage}
          loading={sendLoading}
          messageValue={messageValue}
          setMessageValue={setMessageValue}
        />
      )}

      {/* Confirm delete modal */}
      <ConfirmActionModal
        title="Delete message"
        description="Are you sure you want to delete this message? This action cannot be undone."
        open={showDeleteModal}
        onGoBackward={() => {
          setShowDeleteModal(false);
          setDeleteItemId(null);
        }}
        onGoForward={id => {
          if (id) {
            deleteInboxMutation.mutate(id);
          }
        }}
        itemId={deleteItemId ?? undefined}
        loading={deleteInboxMutation.isPending}
        forwardButtonText="Delete"
        backwardButtonText="Cancel"
        data-testid="confirm-delete-inbox"
      />
    </Box>
  );
};

const InboxDisplayModal: React.FC<{
  open: boolean;
  inbox: IInboxDocument;
  sender?: any;
  onClose: () => void;
  onReply: () => void;
  showReplyInput: boolean;
  replyMessage: string;
  onReplyMessageChange: (message: string) => void;
  onReplySubmit: () => void;
  onReplyCancel: () => void;
  sendLoading: boolean;
}> = ({
  open,
  inbox,
  sender,
  onClose,
  onReply,
  showReplyInput,
  replyMessage,
  onReplyMessageChange,
  onReplySubmit,
  onReplyCancel,
  sendLoading,
}) => {
  const maxChars = 800;
  const [showSenderInfoModal, setShowSenderInfoModal] = useState<boolean>(false);

  return (
    <>
      <Modal
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          alignSelf: 'center',
          justifySelf: 'center',
          width: '100%',
        }}
        open={open}
        onClose={onClose}
      >
        <Sheet
          variant="outlined"
          sx={{
            width: '616px',
            minWidth: '400px',
            maxWidth: '616px',
            borderRadius: 'md',
            p: 4,
            boxShadow: 'lg',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ModalClose />
          <Box sx={{ mb: 2 }}>
            <Typography
              sx={{
                color: 'text.primary',
                fontSize: '20px',
                fontWeight: '400',
                pb: '16px',
                borderBottom: '1px solid',
                borderBottomColor: 'inbox.border.light',
              }}
            >
              Message from{' '}
              <Link
                component="button"
                onClick={() => setShowSenderInfoModal(true)}
                sx={{
                  color: blue[800],
                  textDecoration: 'none',
                  cursor: 'pointer',
                  '&:hover': {
                    textDecoration: 'underline',
                  },
                }}
              >
                {getSenderName(inbox.userId, sender)}
              </Link>
            </Typography>
            <Typography sx={{ color: 'text.primary', fontSize: '16px', fontWeight: '400', pt: '16px' }}>
              {inbox.title}
            </Typography>
          </Box>
          <Box
            sx={{
              borderRadius: '5px',
              minHeight: '150px',
              mt: '-8px',
              pb: '16px',
              borderBottom: '1px solid',
              borderBottomColor: 'inbox.border.light',
            }}
          >
            <Typography
              sx={{
                color: `text.primary`,
                fontSize: '14px',
                fontWeight: '400',
                opacity: '0.75',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {inbox.message}
            </Typography>
          </Box>
          {!showReplyInput && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: '24px' }}>
              <Button color={'primary'} onClick={onReply} sx={blueButtonStyle}>
                Reply
              </Button>
            </Box>
          )}

          {/* Inline Reply Input */}
          {showReplyInput && (
            <Box sx={{ pt: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography sx={{ fontSize: '12px', color: 'text.secondary' }}>Type your reply</Typography>
                <Typography
                  sx={{
                    fontSize: '12px',
                    color: replyMessage.length > maxChars ? red[600] : 'text.secondary',
                    fontWeight: '400',
                  }}
                >
                  {replyMessage.length}/{maxChars}
                </Typography>
              </Box>
              <Textarea
                minRows={4}
                maxRows={8}
                placeholder="Type your reply..."
                value={replyMessage}
                onChange={e => {
                  const value = e.target.value;
                  if (value.length <= maxChars) {
                    onReplyMessageChange(value);
                  }
                }}
                sx={{
                  mb: 2,
                  border: '1px solid',
                  borderColor: replyMessage.length > maxChars ? red[600] : 'border.light',
                  '& textarea::placeholder': {
                    color: 'text.secondary',
                    fontSize: '14px',
                  },
                  '& textarea': {
                    fontSize: '14px',
                  },
                }}
              />
              {/* Buttons */}
              {/* Cancel Button */}
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                <Button
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  onClick={onReplyCancel}
                  sx={{
                    minWidth: '140px',
                    height: '32px !important',
                    minHeight: '32px !important',
                    color: 'text.primary',
                    borderRadius: '8px',
                    fontWeight: '400',
                    border: '1px solid',
                    borderColor: 'text.primary',
                    fontSize: '14px',
                  }}
                >
                  Cancel
                </Button>
                {/* Send Button */}
                <Button
                  color="primary"
                  size="sm"
                  onClick={onReplySubmit}
                  disabled={sendLoading || !replyMessage.trim()}
                  sx={blueButtonStyle}
                >
                  {sendLoading ? <CircularProgress size="sm" /> : 'Send Message'}
                </Button>
              </Box>
            </Box>
          )}
        </Sheet>
      </Modal>
      <SenderInfoModal open={showSenderInfoModal} onClose={() => setShowSenderInfoModal(false)} sender={sender} />
    </>
  );
};

const InboxCreateModal: React.FC<{
  open: boolean;
  onClose: () => void;
  loading: boolean;
  onSubmit: (e: FormEvent) => Promise<void>;
  messageValue: string;
  setMessageValue: (value: string) => void;
}> = ({ open, onClose, onSubmit, loading, messageValue, setMessageValue }) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const maxChars = 800;

  const handleClose = () => {
    setMessageValue('');
    onClose();
  };

  return (
    <Modal sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }} open={open} onClose={handleClose}>
      <Sheet
        variant="outlined"
        sx={{
          minWidth: isMobile ? '95%' : '616px',
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
          backgroundColor: 'background.body',
        }}
      >
        <ModalClose />
        <Typography sx={{ color: 'text.primary', fontSize: '20px', fontWeight: '400' }}>
          {t('inbox.sendMessage')}
        </Typography>
        <form onSubmit={onSubmit}>
          <Box mt={2} sx={{ display: 'grid', gap: '15px' }}>
            <FormControl required id="receiver">
              <FormLabel id="reciever-label" sx={labelStyle}>
                Username or email
              </FormLabel>
              <Input
                variant="outlined"
                fullWidth
                name="receiver"
                placeholder={'Username or email@email.com'}
                sx={inputStyle}
              />
            </FormControl>
            <FormControl required id="ttle">
              <FormLabel id="ttle-label" sx={labelStyle}>
                Title
              </FormLabel>
              <Input variant="outlined" fullWidth name="ttle" placeholder={'Title'} sx={inputStyle} />
            </FormControl>
            <FormControl required id="message">
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: '4px' }}>
                <FormLabel id="message-label" sx={labelStyle}>
                  Message
                </FormLabel>
                <Typography
                  sx={{
                    fontSize: '12px',
                    color: messageValue.length > maxChars ? red[600] : 'text.primary50',
                    fontWeight: '400',
                  }}
                >
                  {messageValue.length}/{maxChars}
                </Typography>
              </Box>
              <Textarea
                minRows={6}
                maxRows={12}
                size="lg"
                name="message"
                placeholder="Message"
                variant={'outlined'}
                value={messageValue}
                onChange={e => {
                  const value = e.target.value;
                  if (value.length <= maxChars) {
                    setMessageValue(value);
                  }
                }}
                sx={{
                  border: '1px solid',
                  borderColor: messageValue.length > maxChars ? red[600] : 'border.light',
                  backgroundColor: 'inbox.backgroundColor.textInput',
                  '& textarea::placeholder': {
                    color: 'text.primary50',
                    fontWeight: '400',
                    fontSize: '14px',
                  },
                  '& textarea': {
                    color: 'text.primary',
                    fontSize: '14px',
                    fontWeight: '400',
                  },
                }}
              />
            </FormControl>
          </Box>
          <Box mt={'24px'} sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            {/* Cancel Button */}
            <Button
              onClick={handleClose}
              color={'primary'}
              variant={'outlined'}
              disabled={loading}
              sx={{
                minWidth: '140px',
                borderRadius: '8px',
                color: 'text.primary',
                fontSize: '14px',
                fontWeight: '400',
                height: '32px !important',
                minHeight: '32px !important',
                border: '1px solid',
                backgroundColor: 'transparent',
                borderColor: 'inbox.border.cancelButton',
                mr: '20px',
              }}
            >
              Cancel
            </Button>
            {/* Send Button */}
            <Button
              disabled={loading}
              type={'submit'}
              color={'primary'}
              sx={{
                minWidth: '140px',
                borderRadius: '8px',
                color: gray[200],
                fontSize: '14px',
                fontWeight: '400',
                height: '32px !important',
                minHeight: '32px !important',
              }}
            >
              {loading ? <CircularProgress /> : 'Send'}
            </Button>
          </Box>
        </form>
      </Sheet>
    </Modal>
  );
};

export default Messages;
