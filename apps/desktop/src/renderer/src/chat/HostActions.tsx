import { useCallback, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { HostEntry, HostRunningWork } from '@shared/hostConnection';
import { hostActions, type HostAction } from '../host/hostPresentation';
import { hostOperations, useHostOperation } from '../host/hostOperations';
import { useDesktopVersion } from '../host/useDesktopVersion';
import { HostSignInSheet } from './HostSignInSheet';

const ACTION_LABEL: Record<HostAction, string> = {
  add: 'Add',
  connect: 'Connect',
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
  install: 'Install',
  update: 'Update',
  signIn: 'Sign in',
  remove: 'Remove',
};

/** Actions that stop something are never the highlighted one. */
const QUIET: ReadonlySet<HostAction> = new Set(['disconnect', 'remove']);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function describeWork(work: HostRunningWork): string {
  if (work.kind === 'unknown') {
    return 'This host runs an older version, so what it is doing cannot be listed. Updating may interrupt work in progress.';
  }
  const count = work.sessions.length;
  return `${count} ${count === 1 ? 'session is' : 'sessions are'} running on it. Updating stops them.`;
}

/** The one place Desktop asks before writing to a machine: what is written, and where. */
function InstallConsentDialog({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open onClose={onCancel} data-testid="host-install-consent">
      <ModalDialog size="md" sx={{ width: 440, maxWidth: 'calc(100vw - 32px)' }}>
        <DialogTitle>Install the Bike4Mind host on {label}?</DialogTitle>
        <DialogContent>
          <Typography level="body-sm">
            Desktop copies the host program to <code>~/.b4m/host</code> on {label} over your SSH connection. Nothing
            else on that machine is changed, and Node.js is not installed for you.
          </Typography>
          <Typography level="body-sm" sx={{ mt: 1 }}>
            You are asked once. Later updates that interrupt nothing run without asking.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onConfirm} data-testid="host-install-consent-confirm-btn">
            Install
          </Button>
          <Button variant="plain" color="neutral" onClick={onCancel} data-testid="host-install-consent-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

function UpdateConfirmDialog({
  label,
  work,
  onConfirm,
  onCancel,
}: {
  label: string;
  work: HostRunningWork;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open onClose={onCancel} data-testid="host-update-confirm">
      <ModalDialog size="md" sx={{ width: 440, maxWidth: 'calc(100vw - 32px)' }} color="warning" variant="outlined">
        <DialogTitle>Update {label} while it is working?</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" data-testid="host-update-confirm-work">
            {describeWork(work)}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button color="warning" onClick={onConfirm} data-testid="host-update-confirm-btn">
            Update and interrupt
          </Button>
          <Button variant="plain" color="neutral" onClick={onCancel} data-testid="host-update-cancel-btn">
            Not now
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

function RemoveConfirmDialog({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open onClose={onCancel} data-testid="host-remove-confirm">
      <ModalDialog size="md" sx={{ width: 420, maxWidth: 'calc(100vw - 32px)' }}>
        <DialogTitle>Remove {label}?</DialogTitle>
        <DialogContent>
          <Typography level="body-sm">
            Its projects leave the sidebar. Nothing on that machine is changed; add it again any time.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button color="danger" onClick={onConfirm} data-testid="host-remove-confirm-btn">
            Remove
          </Button>
          <Button variant="plain" color="neutral" onClick={onCancel} data-testid="host-remove-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

type Dialog = 'consent' | 'signIn' | 'remove' | 'update' | null;

export type HostActionsController = {
  actions: readonly HostAction[];
  busy: boolean;
  error: string | null;
  run: (action: HostAction) => void;
  /** The dialogs behind the actions. Render them outside any popup the buttons sit in, or closing it closes them. */
  dialogs: ReactNode;
};

/**
 * What a host's state lets the user do, and the dialogs behind it: consent before an install, a
 * question before an update that would interrupt work, and the sign-in sheet. `allowed` narrows
 * the set for a surface that offers fewer (the sidebar panel has no Install or Remove).
 */
export function useHostActions(entry: HostEntry, allowed?: readonly HostAction[]): HostActionsController {
  const desktopVersion = useDesktopVersion();
  const operation = useHostOperation(entry.hostId);
  const [dialog, setDialog] = useState<Dialog>(null);
  // Consent is asked for once per host in a window: a retry after a failed install does not re-ask.
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = useCallback(async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(message(failure));
    }
  }, []);

  const install = useCallback(() => {
    setConsented(true);
    setDialog(null);
    void hostOperations.install(entry.hostId);
  }, [entry.hostId]);

  const update = useCallback(
    async (force: boolean) => {
      setDialog('update');
      await hostOperations.update(entry.hostId, force);
      if (hostOperations.get(entry.hostId).status !== 'needsConfirmation') setDialog(null);
    },
    [entry.hostId]
  );

  const run = (action: HostAction) => {
    const { hostId } = entry;
    switch (action) {
      case 'connect':
        return void attempt(() => window.b4m.host.connect(hostId));
      case 'reconnect':
        return void attempt(async () => {
          if (entry.state.status === 'connected') await window.b4m.host.disconnect(hostId);
          await window.b4m.host.connect(hostId);
        });
      case 'disconnect':
        return void attempt(() => window.b4m.host.disconnect(hostId));
      case 'install':
        return consented ? install() : setDialog('consent');
      case 'update':
        return void update(false);
      case 'signIn':
        return setDialog('signIn');
      case 'remove':
        return setDialog('remove');
      case 'add':
        return;
    }
  };

  const actions = hostActions(entry, desktopVersion).filter(action => !allowed || allowed.includes(action));
  const dialogs = (
    <>
      {dialog === 'consent' && (
        <InstallConsentDialog label={entry.label} onConfirm={install} onCancel={() => setDialog(null)} />
      )}
      {dialog === 'remove' && (
        <RemoveConfirmDialog
          label={entry.label}
          onConfirm={() => {
            setDialog(null);
            void attempt(() => window.b4m.host.remove(entry.hostId));
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'signIn' && <HostSignInSheet entry={entry} onClose={() => setDialog(null)} />}
      {dialog === 'update' && operation.status === 'needsConfirmation' && (
        <UpdateConfirmDialog
          label={entry.label}
          work={operation.work}
          onConfirm={() => void update(true)}
          onCancel={() => {
            hostOperations.dismiss(entry.hostId);
            setDialog(null);
          }}
        />
      )}
    </>
  );
  return { actions, busy: operation.status === 'running', error, run, dialogs };
}

export function HostActionButtons({
  controller,
  size = 'sm',
  testIdPrefix = 'host-action',
  onRan,
}: {
  controller: HostActionsController;
  size?: 'sm' | 'md';
  testIdPrefix?: string;
  /** Called after a button is pressed, so a popup holding the buttons can close. */
  onRan?: () => void;
}) {
  const { actions, busy, error, run } = controller;
  return (
    <>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {actions.map((action, index) => (
          <Button
            key={action}
            size={size}
            variant={index === 0 && !QUIET.has(action) ? 'solid' : 'outlined'}
            color={action === 'remove' ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => {
              run(action);
              onRan?.();
            }}
            data-testid={`${testIdPrefix}-${action}-btn`}
          >
            {ACTION_LABEL[action]}
          </Button>
        ))}
      </Stack>
      {error && (
        <Alert color="danger" size="sm" sx={{ mt: 0.75 }} data-testid={`${testIdPrefix}-error`}>
          {error}
        </Alert>
      )}
    </>
  );
}

/** The action buttons and their dialogs together, for a surface that is not a popup. */
export function HostActions({
  entry,
  allowed,
  size,
  testIdPrefix,
}: {
  entry: HostEntry;
  allowed?: readonly HostAction[];
  size?: 'sm' | 'md';
  testIdPrefix?: string;
}) {
  const controller = useHostActions(entry, allowed);
  return (
    <>
      <HostActionButtons controller={controller} size={size} testIdPrefix={testIdPrefix} />
      {controller.dialogs}
    </>
  );
}
