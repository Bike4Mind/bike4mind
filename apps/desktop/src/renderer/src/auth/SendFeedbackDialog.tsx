import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import { CheckIcon, ConversationIcon, WarningIcon } from '../chat/icons';

export function SendFeedbackDialog({ onClose }: { onClose: () => void }) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ color: 'success' | 'warning' | 'danger'; message: string } | null>(null);
  const submitted = notice?.color !== 'danger' && notice !== null;

  const send = async () => {
    if (!content.trim() || sending || submitted) return;
    setSending(true);
    setNotice(null);
    try {
      const result = await window.b4m.account.sendFeedback(content);
      if (result.ok) {
        setNotice({
          color: result.warning ? 'warning' : 'success',
          message: result.warning ?? 'Thank you! Your feedback has been submitted.',
        });
      } else {
        setNotice({ color: 'danger', message: result.error });
      }
    } catch {
      setNotice({ color: 'danger', message: 'Could not submit your feedback. Please try again.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal open onClose={sending ? undefined : onClose}>
      <ModalDialog
        aria-labelledby="send-feedback-title"
        data-testid="send-feedback-dialog"
        sx={{ width: 'min(480px, calc(100vw - 32px))', p: 0, gap: 0, overflow: 'hidden', borderRadius: 'lg' }}
      >
        {submitted ? (
          <Box sx={{ px: 4, pt: 4, pb: 3, textAlign: 'center' }}>
            <Box
              sx={{
                width: 52,
                height: 52,
                mx: 'auto',
                mb: 2,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                bgcolor: notice.color === 'warning' ? 'warning.softBg' : 'success.softBg',
                color: notice.color === 'warning' ? 'warning.600' : 'success.600',
              }}
            >
              {notice.color === 'warning' ? <WarningIcon /> : <CheckIcon />}
            </Box>
            <Typography id="send-feedback-title" level="h3" sx={{ mb: 1 }}>
              {notice.color === 'warning' ? 'Feedback saved' : 'Feedback sent'}
            </Typography>
            <Typography level="body-sm" textColor="text.secondary" data-testid="send-feedback-notice">
              {notice.message}
            </Typography>
            <Button sx={{ mt: 3, minWidth: 120 }} onClick={onClose} data-testid="send-feedback-close-btn">
              Close
            </Button>
          </Box>
        ) : (
          <>
            <Box sx={{ px: 3, pt: 3, pb: 2.5 }}>
              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 2 }}>
                <Box
                  sx={{
                    width: 40,
                    height: 40,
                    borderRadius: 'md',
                    display: 'grid',
                    placeItems: 'center',
                    bgcolor: 'primary.softBg',
                    color: 'primary.600',
                  }}
                >
                  <ConversationIcon />
                </Box>
                <Typography id="send-feedback-title" level="h3">
                  Send feedback
                </Typography>
              </Box>
              <Typography level="body-sm" textColor="text.secondary" sx={{ mb: 2.5 }}>
                Tell us what could be better, ask a question, or report a bug.
              </Typography>
              <Typography level="title-sm" component="label" htmlFor="send-feedback-textarea" sx={{ mb: 0.75 }}>
                Your message
              </Typography>
              <Textarea
                autoFocus
                minRows={6}
                value={content}
                placeholder="What's on your mind?"
                onChange={event => setContent(event.target.value)}
                slotProps={{ textarea: { id: 'send-feedback-textarea', 'data-testid': 'send-feedback-textarea' } }}
                sx={{ width: '100%' }}
              />
              {notice && (
                <Alert color="danger" variant="soft" size="sm" sx={{ mt: 1.5 }} data-testid="send-feedback-notice">
                  {notice.message}
                </Alert>
              )}
            </Box>
            <Box
              sx={{
                px: 3,
                py: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 1,
                borderTop: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Button
                variant="plain"
                color="neutral"
                disabled={sending}
                onClick={onClose}
                data-testid="send-feedback-close-btn"
              >
                Cancel
              </Button>
              <Button
                loading={sending}
                disabled={!content.trim() || sending}
                onClick={() => void send()}
                data-testid="send-feedback-submit-btn"
              >
                Send feedback
              </Button>
            </Box>
          </>
        )}
      </ModalDialog>
    </Modal>
  );
}
