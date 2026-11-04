import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Textarea from '@mui/joy/Textarea';
import type { ChatSessionSummary } from '@shared/chat';

/**
 * Sends the user's own message into a conversation that is not the open one. It goes through the
 * same path as the composer's send, so it is a user turn (or queues behind a running one), not a
 * relay from another session.
 */
export function MessageSessionDialog({
  session,
  onClose,
}: {
  session: Pick<ChatSessionSummary, 'id' | 'title'>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSend = text.trim().length > 0 && !sending;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const result = await window.b4m.chat.sendMessage({ sessionId: session.id, text: text.trim() });
      if (result.ok) {
        onClose();
        return;
      }
      setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the message');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal open onClose={sending ? undefined : onClose}>
      <ModalDialog data-testid="message-session-dialog" sx={{ width: 'min(480px, 90vw)' }}>
        <DialogTitle>Message session</DialogTitle>
        <DialogContent>
          <Textarea
            autoFocus
            minRows={3}
            maxRows={10}
            value={text}
            placeholder={`Message "${session.title}"`}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            slotProps={{ textarea: { 'data-testid': 'message-session-input', 'aria-label': 'Message' } }}
          />
          {error && (
            <Alert size="sm" color="danger" variant="soft" sx={{ mt: 1 }} data-testid="message-session-error">
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            variant="solid"
            loading={sending}
            disabled={!canSend}
            onClick={() => void send()}
            data-testid="message-session-send-btn"
          >
            Send
          </Button>
          <Button
            variant="plain"
            color="neutral"
            disabled={sending}
            onClick={onClose}
            data-testid="message-session-cancel-btn"
          >
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
