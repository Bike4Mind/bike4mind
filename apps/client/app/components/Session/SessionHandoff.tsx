import { useEffect, useState } from 'react';
import { Alert, Button, DialogTitle, IconButton, Modal, ModalDialog, Stack, Typography } from '@mui/joy';
import DevicesIcon from '@mui/icons-material/Devices';
import { useNavigate } from '@tanstack/react-router';
import { HandoffDevicesResponseSchema, SessionHandoffAction, type HandoffDevice } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';

export function SessionHandoffButton({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<HandoffDevice[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setDevices([]);
    setMessage('');
    api
      .get('/api/v1/handoff-devices')
      .then(response => {
        if (!cancelled) setDevices(HandoffDevicesResponseSchema.parse(response.data).devices);
      })
      .catch(() => {
        if (!cancelled) setMessage('Could not load devices. Try again.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const send = async (deviceId: string) => {
    setBusy(true);
    setMessage('');
    try {
      await api.post('/api/v1/session-handoffs', { deviceId, sessionId });
      setMessage('Sent. Open the notification on your other device. Phone delivery may take a moment.');
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      setMessage(
        status === 409
          ? 'This device looks inactive. Open it, sign in, and try again.'
          : 'Could not send this conversation. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {compact ? (
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Open on another device"
          data-testid="session-handoff-open-btn"
          onClick={() => setOpen(true)}
        >
          <DevicesIcon />
        </IconButton>
      ) : (
        <Button size="sm" variant="plain" data-testid="session-handoff-open-btn" onClick={() => setOpen(true)}>
          Open on another device
        </Button>
      )}
      <Modal open={open} onClose={() => setOpen(false)}>
        <ModalDialog data-testid="session-handoff-dialog">
          <DialogTitle>Open on another device</DialogTitle>
          <Typography level="body-sm">
            Web and desktop server conversations must stay open and signed in. iPhone/iPad notifications must be
            enabled. Local desktop chats stay on that device.
          </Typography>
          <Stack spacing={1}>
            {devices.map(device => (
              <Button
                key={device.id}
                variant="outlined"
                disabled={busy || !device.available}
                data-testid="session-handoff-device-btn"
                onClick={() => void send(device.id)}
              >
                {device.name} ({device.platform}){device.available ? '' : ' - inactive'}
              </Button>
            ))}
            {!busy && devices.length === 0 && (
              <Typography>No registered devices. Open and sign in on your other device first.</Typography>
            )}
            {message && <Alert data-testid="session-handoff-feedback">{message}</Alert>}
            <Button variant="plain" data-testid="session-handoff-close-btn" onClick={() => setOpen(false)}>
              Close
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </>
  );
}

export function SessionHandoffReceiver() {
  const { subscribeToAction } = useWebsocket();
  const accessToken = useAccessToken(state => state.accessToken);
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    setSessionId(null);
  }, [accessToken]);
  useEffect(
    () =>
      subscribeToAction('session_handoff', async message => {
        const parsed = SessionHandoffAction.safeParse(message);
        if (parsed.success) setSessionId(parsed.data.sessionId);
      }),
    [subscribeToAction]
  );
  return (
    <Modal open={sessionId !== null} onClose={() => setSessionId(null)}>
      <ModalDialog data-testid="session-handoff-received-dialog">
        <DialogTitle>Continue your conversation here?</DialogTitle>
        <Typography level="body-sm">You sent a conversation to this device.</Typography>
        <Button
          data-testid="session-handoff-continue-btn"
          onClick={() => {
            if (sessionId) void navigate({ to: '/notebooks/$id', params: { id: sessionId } });
            setSessionId(null);
          }}
        >
          Continue here
        </Button>
        <Button variant="plain" data-testid="session-handoff-dismiss-btn" onClick={() => setSessionId(null)}>
          Not now
        </Button>
      </ModalDialog>
    </Modal>
  );
}
