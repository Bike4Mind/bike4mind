import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import IconButton from '@mui/joy/IconButton';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import ListSubheader from '@mui/joy/ListSubheader';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Typography from '@mui/joy/Typography';
import type { RecentFolder } from '@shared/chat';
import { hostChat, type FolderListing } from '../host/hostChat';
import { ArrowUpIcon, FolderIcon } from './icons';
import { thinScrollbarSx } from './layout';

/** The calls the picker makes; hostChat's by default, a fake in tests. */
export type FolderSource = {
  browse(hostId: string, path?: string): Promise<FolderListing>;
  recent(hostId: string): Promise<RecentFolder[]>;
};

const hostFolderSource: FolderSource = {
  browse: (hostId, path) => hostChat.browseFolder(hostId, path),
  recent: hostId => hostChat.listRecentFolders(hostId),
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Picks a project folder on a host Desktop does not run on, where the native dialog cannot look.
 * Browses with `fs/browse` (directories only, starting at the host's home) and offers the host's
 * `project/recent` list first. The local host keeps the native dialog; see ProjectChip.
 */
export function HostFolderPicker({
  hostId,
  hostLabel,
  onPick,
  onClose,
  source = hostFolderSource,
}: {
  hostId: string;
  /** The host's name as the user knows it, for the title. */
  hostLabel: string;
  onPick: (path: string) => void;
  onClose: () => void;
  source?: FolderSource;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [recent, setRecent] = useState<readonly RecentFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the latest browse may apply: a slow answer for a folder the user already left must not
  // replace the one they are in.
  const latest = useRef(0);

  const browse = useCallback(
    async (path?: string) => {
      const ticket = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const next = await source.browse(hostId, path);
        if (ticket === latest.current) setListing(next);
      } catch (cause) {
        if (ticket === latest.current) setError(message(cause));
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [hostId, source]
  );

  useEffect(() => {
    void browse();
    let live = true;
    source
      .recent(hostId)
      .then(folders => live && setRecent(folders))
      // The recent list is a shortcut; browsing still works without it.
      .catch((cause: unknown) => console.warn(`Could not read the recent folders of host ${hostId}`, cause));
    return () => {
      live = false;
    };
  }, [hostId, source, browse]);

  const visible = listing?.entries.filter(entry => !entry.isHidden) ?? [];

  return (
    <Modal open onClose={onClose}>
      <ModalDialog data-testid="host-folder-picker" sx={{ width: 520, maxWidth: 'calc(100vw - 32px)' }}>
        <DialogTitle>Open folder on {hostLabel}</DialogTitle>
        <DialogContent sx={{ gap: 1 }}>
          <Typography level="body-xs" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
            <IconButton
              size="sm"
              variant="plain"
              aria-label="Parent folder"
              disabled={!listing?.parent || loading}
              onClick={() => listing?.parent && void browse(listing.parent)}
              data-testid="host-folder-picker-up-btn"
            >
              <ArrowUpIcon />
            </IconButton>
            <Typography component="span" level="body-xs" noWrap data-testid="host-folder-picker-path">
              {listing?.path ?? ''}
            </Typography>
          </Typography>
          {error && (
            <Alert color="danger" size="sm" data-testid="host-folder-picker-error">
              {error}
            </Alert>
          )}
          <List size="sm" sx={{ maxHeight: 360, overflow: 'auto', ...thinScrollbarSx }}>
            {recent.length > 0 && (
              <ListItem nested>
                <ListSubheader>Recent</ListSubheader>
                <List size="sm">
                  {recent.map(folder => (
                    <ListItem key={folder.path}>
                      <ListItemButton
                        onClick={() => onPick(folder.path)}
                        title={folder.path}
                        data-testid="host-folder-picker-recent-item"
                      >
                        <ListItemDecorator>
                          <FolderIcon />
                        </ListItemDecorator>
                        {folder.name}
                      </ListItemButton>
                    </ListItem>
                  ))}
                </List>
              </ListItem>
            )}
            <ListItem nested>
              <ListSubheader>Folders</ListSubheader>
              <List size="sm">
                {visible.map(entry => (
                  <ListItem key={entry.path}>
                    <ListItemButton
                      disabled={loading}
                      onClick={() => void browse(entry.path)}
                      data-testid="host-folder-picker-entry"
                    >
                      <ListItemDecorator>
                        <FolderIcon />
                      </ListItemDecorator>
                      <Typography noWrap sx={{ flex: 1, minWidth: 0 }}>
                        {entry.name}
                      </Typography>
                      {entry.isGitRepository && (
                        <Chip size="sm" variant="soft">
                          git
                        </Chip>
                      )}
                    </ListItemButton>
                  </ListItem>
                ))}
                {!loading && !error && visible.length === 0 && (
                  <ListItem>
                    <Typography level="body-xs" data-testid="host-folder-picker-empty">
                      No folders here.
                    </Typography>
                  </ListItem>
                )}
              </List>
            </ListItem>
          </List>
          {listing?.truncated && (
            <Typography level="body-xs" data-testid="host-folder-picker-truncated">
              Showing the first {listing.entries.length} entries.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={!listing || loading}
            onClick={() => listing && onPick(listing.path)}
            data-testid="host-folder-picker-choose-btn"
          >
            Open this folder
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="host-folder-picker-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
