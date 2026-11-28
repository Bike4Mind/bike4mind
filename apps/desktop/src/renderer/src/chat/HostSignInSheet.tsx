import { useEffect, useRef } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { HostEntry } from '@shared/hostConnection';
import { hostCommands, useHostCommandError } from '../host/hostCommands';
import { hostStatusView } from '../host/hostPresentation';
import { useHostSignIn, type HostSignIn } from '../host/useHostSignIn';
import { useNow } from '../host/useNow';
import { CopyMessageButton } from './CopyMessageButton';

function SignInBody({ signIn }: { signIn: HostSignIn }) {
  const { flow } = signIn;
  if (flow.status === 'waiting') {
    return (
      <Stack spacing={1.5}>
        <Typography level="body-sm">
          Your browser opened the sign-in page. Check that it shows this code, then approve it.
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography level="h3" sx={{ fontFamily: 'monospace', letterSpacing: 2 }} data-testid="host-signin-code">
            {flow.userCode}
          </Typography>
          <CopyMessageButton text={flow.userCode} label="Copy code" testId="host-signin-copy-code-btn" />
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography level="body-xs" noWrap sx={{ minWidth: 0 }} data-testid="host-signin-link">
            {flow.verificationUrl}
          </Typography>
          <CopyMessageButton text={flow.verificationUrl} label="Copy link" testId="host-signin-copy-link-btn" />
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <CircularProgress size="sm" />
          <Typography level="body-xs">Waiting for you to approve it</Typography>
        </Stack>
      </Stack>
    );
  }
  if (flow.status === 'expired') {
    return (
      <Alert color="warning" data-testid="host-signin-expired">
        This code expired. Get a new one to try again.
      </Alert>
    );
  }
  if (flow.status === 'failed') {
    return (
      <Alert color="danger" data-testid="host-signin-failed">
        {flow.message}
      </Alert>
    );
  }
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} data-testid="host-signin-starting">
      <CircularProgress size="sm" />
      <Typography level="body-sm">Asking the host for a sign-in code</Typography>
    </Stack>
  );
}

/** The host left the sign-in without becoming connected: say where it is, and offer the way back. */
function InterruptedBody({ entry }: { entry: HostEntry }) {
  const now = useNow();
  const commandError = useHostCommandError(entry.hostId);
  const { status } = entry.state;
  if (status === 'connecting' || status === 'reconnecting') {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} data-testid="host-signin-connecting">
        <CircularProgress size="sm" />
        <Typography level="body-sm">Connecting to {entry.label}</Typography>
      </Stack>
    );
  }
  const view = hostStatusView(entry.state, '', now);
  return (
    <Alert color="warning" data-testid="host-signin-interrupted">
      <Stack spacing={0.5}>
        <Typography level="title-sm">Signing in did not finish: {view.label.toLowerCase()}</Typography>
        {view.detail && <Typography level="body-xs">{view.detail}</Typography>}
        {commandError && <Typography level="body-xs">{commandError}</Typography>}
      </Stack>
    </Alert>
  );
}

/**
 * Signs a host in to the user's account with the device flow: the host mints a code, the user
 * approves it in a browser on this computer. Closes itself only once the host is connected; a
 * host that drops meanwhile keeps the sheet open with the reason and a way to reconnect.
 */
export function HostSignInSheet({
  entry,
  onClose,
  signIn: injected,
}: {
  entry: HostEntry;
  onClose: () => void;
  /** Replaced in tests. */
  signIn?: HostSignIn;
}) {
  const own = useHostSignIn(entry.hostId);
  const signIn = injected ?? own;
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    signIn.start();
  }, [signIn]);

  const stillNeedsSignIn = entry.state.status === 'needsSignIn';
  const connected = entry.state.status === 'connected';
  useEffect(() => {
    if (connected) onClose();
  }, [connected, onClose]);

  const retryable = stillNeedsSignIn && (signIn.flow.status === 'expired' || signIn.flow.status === 'failed');
  const status = entry.state.status;
  const canReconnect = !stillNeedsSignIn && status !== 'connecting' && status !== 'reconnecting' && !connected;
  return (
    <Modal open onClose={onClose} data-testid="host-signin-sheet">
      <ModalDialog size="md" sx={{ width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <DialogTitle>Sign in on {entry.label}</DialogTitle>
        <DialogContent>
          {stillNeedsSignIn ? <SignInBody signIn={signIn} /> : <InterruptedBody entry={entry} />}
        </DialogContent>
        <DialogActions>
          {canReconnect && (
            <Button
              onClick={() => void hostCommands.reconnect(entry.hostId, false)}
              data-testid="host-signin-reconnect-btn"
            >
              Reconnect
            </Button>
          )}
          {retryable && (
            <Button onClick={signIn.start} data-testid="host-signin-retry-btn">
              Get a new code
            </Button>
          )}
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="host-signin-cancel-btn">
            Close
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
