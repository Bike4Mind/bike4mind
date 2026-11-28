import { useState } from 'react';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Dropdown from '@mui/joy/Dropdown';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Radio from '@mui/joy/Radio';
import RadioGroup from '@mui/joy/RadioGroup';
import Typography from '@mui/joy/Typography';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import type { HostEntry } from '@shared/hostConnection';
import { useHostEntries } from '../host/hostRegistry';
import { HostFolderPicker } from './HostFolderPicker';
import { FolderPlusIcon, PlusIcon, ServerIcon } from './icons';

/** Hosts a session can start on now: the local one, then each connected remote one. */
const startableHosts = (entries: readonly HostEntry[]): HostEntry[] =>
  entries.filter(entry => entry.state.status === 'connected');

const remoteStartable = (entries: readonly HostEntry[]): HostEntry[] =>
  startableHosts(entries).filter(entry => entry.kind === 'remote');

/**
 * Where a new project lives, then which folder. This computer opens the native dialog; a
 * connected host is browsed over its protocol (HostFolderPicker).
 */
function AddProjectDialog({
  hosts,
  pickLocalFolder,
  onPick,
  onClose,
}: {
  hosts: readonly HostEntry[];
  pickLocalFolder: () => Promise<string | null | undefined>;
  onPick: (hostId: string, directory: string) => void;
  onClose: () => void;
}) {
  const [hostId, setHostId] = useState(LOCAL_HOST_ID);
  const [browsing, setBrowsing] = useState(false);
  const target = hosts.find(entry => entry.hostId === hostId);

  const next = async () => {
    if (hostId !== LOCAL_HOST_ID) return setBrowsing(true);
    const directory = await pickLocalFolder();
    if (!directory) return;
    onPick(LOCAL_HOST_ID, directory);
    onClose();
  };

  if (browsing && target) {
    return (
      <HostFolderPicker
        hostId={target.hostId}
        hostLabel={target.label}
        onPick={path => {
          onPick(target.hostId, path);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }
  return (
    <Modal open onClose={onClose} data-testid="add-project-dialog">
      <ModalDialog size="md" sx={{ width: 380, maxWidth: 'calc(100vw - 32px)' }}>
        <DialogTitle>Add project</DialogTitle>
        <DialogContent>
          Where is the folder?
          <RadioGroup value={hostId} onChange={event => setHostId(event.target.value)} sx={{ mt: 1, gap: 1 }}>
            {hosts.map(entry => (
              <Radio
                key={entry.hostId}
                value={entry.hostId}
                label={entry.kind === 'local' ? 'This computer' : entry.label}
                data-testid={`add-project-host-${entry.hostId}`}
              />
            ))}
          </RadioGroup>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1.5 }} data-testid="add-project-note">
            A new session opens on the folder. The project shows in the sidebar once you send its first message.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void next()} data-testid="add-project-continue-btn">
            Choose folder
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="add-project-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

/**
 * The sidebar's way to start work on another machine: a new session on a connected host, and Add
 * project, which asks where first. Draws nothing until a remote host is connected, so with only
 * this computer the sidebar is as it was.
 */
export function HostNewMenu({
  onNewSessionOnHost,
  onAddProject,
  pickLocalFolder = () => window.b4m.chat.pickProjectDirectory(),
}: {
  onNewSessionOnHost: (hostId: string) => void;
  onAddProject: (hostId: string, directory: string) => void;
  pickLocalFolder?: () => Promise<string | null | undefined>;
}) {
  const entries = useHostEntries();
  const [adding, setAdding] = useState(false);
  const remote = remoteStartable(entries);
  if (remote.length === 0) return null;
  return (
    <>
      <Dropdown>
        <MenuButton
          size="sm"
          variant="plain"
          color="neutral"
          startDecorator={<ServerIcon />}
          sx={{ justifyContent: 'flex-start', fontWeight: 'md', '--Button-gap': '10px', width: '100%' }}
          slotProps={{ root: { 'data-testid': 'host-new-menu-btn' } }}
        >
          New on a host
        </MenuButton>
        <Menu size="sm" placement="bottom-start" data-testid="host-new-menu">
          {remote.map(entry => (
            <MenuItem
              key={entry.hostId}
              onClick={() => onNewSessionOnHost(entry.hostId)}
              data-testid={`host-new-session-${entry.hostId}`}
            >
              <ListItemDecorator>
                <PlusIcon />
              </ListItemDecorator>
              New session on {entry.label}
            </MenuItem>
          ))}
          <MenuItem onClick={() => setAdding(true)} data-testid="host-add-project">
            <ListItemDecorator>
              <FolderPlusIcon />
            </ListItemDecorator>
            Add project...
          </MenuItem>
        </Menu>
      </Dropdown>
      {adding && (
        <AddProjectDialog
          hosts={startableHosts(entries)}
          pickLocalFolder={pickLocalFolder}
          onPick={onAddProject}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
