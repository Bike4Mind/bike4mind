import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { CloseIcon, FolderIcon } from './icons';

const DISMISSED_KEY = 'b4m.sidebar.folderCard.dismissed';

/**
 * The dismissible card above the account strip.
 *
 * The reference fills this slot with a "get the app" promo, which has no counterpart here. It
 * holds the one thing a new install genuinely needs to be told instead: until a folder is
 * shared, every file and shell tool refuses, and nothing else in the UI says so until the
 * model tries one and fails.
 *
 * It takes itself away on either of the two things that make it pointless - the folder being
 * granted, or the user saying no - and the dismissal is per-machine UI state, which is what
 * localStorage is for.
 */
export function SidebarCard() {
  const [roots, setRoots] = useState<string[] | null>(null);
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.b4m.tools.getAccess().then(state => setRoots(state.roots));
  }, []);

  const grant = useCallback(async () => {
    setBusy(true);
    try {
      setRoots((await window.b4m.tools.grantAccess()).roots);
    } finally {
      setBusy(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // A browser with storage blocked still gets the dismissal for this run; losing it on the
      // next launch is a far smaller problem than the card throwing on the way out.
    }
  }, []);

  // `null` is "not read yet", which must not flash the card at a user who already has folders.
  if (dismissed || roots === null || roots.length > 0) return null;

  return (
    <Sheet variant="soft" sx={{ m: 1, p: 1.25, borderRadius: 'sm' }} data-testid="sidebar-card">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ color: 'text.tertiary', pt: 0.25 }}>
          <FolderIcon />
        </Box>
        <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-xs" sx={{ fontWeight: 'lg' }}>
            Share a folder
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            Code sessions cannot read files or run commands until you pick one.
          </Typography>
          <Button
            size="sm"
            variant="soft"
            color="primary"
            loading={busy}
            onClick={() => void grant()}
            data-testid="sidebar-card-grant-btn"
          >
            Choose folder
          </Button>
        </Stack>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Dismiss"
          onClick={dismiss}
          data-testid="sidebar-card-dismiss-btn"
        >
          <CloseIcon />
        </IconButton>
      </Stack>
    </Sheet>
  );
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}
