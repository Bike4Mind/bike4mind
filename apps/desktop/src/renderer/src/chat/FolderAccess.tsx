import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';

/**
 * Which folders the model's tools may reach, and the only place to change that.
 *
 * Granting goes through the OS folder picker in main, so nothing the model says can widen
 * this list - it can only ask the user to.
 */
export function FolderAccess() {
  const [roots, setRoots] = useState<string[]>([]);
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

  const revoke = useCallback(async (root: string) => {
    setRoots((await window.b4m.tools.revokeAccess(root)).roots);
  }, []);

  return (
    <Box component="details" data-testid="tool-access-panel">
      <Typography component="summary" level="body-xs" textColor="text.tertiary" sx={{ cursor: 'pointer' }}>
        File access{roots.length > 0 ? ` (${roots.length})` : ''}
      </Typography>

      <Stack spacing={0.5} sx={{ pt: 1 }}>
        {roots.length === 0 ? (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="tool-access-empty">
            No folders shared. The assistant cannot read any files.
          </Typography>
        ) : (
          roots.map(root => (
            <Stack key={root} direction="row" spacing={0.5} alignItems="center" data-testid="tool-access-root">
              <Typography level="body-xs" fontFamily="monospace" noWrap sx={{ flex: 1, minWidth: 0 }} title={root}>
                {root}
              </Typography>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label={`Stop sharing ${root}`}
                onClick={() => void revoke(root)}
                data-testid="tool-access-revoke-btn"
              >
                <Typography level="body-xs">x</Typography>
              </IconButton>
            </Stack>
          ))
        )}

        <Button
          size="sm"
          variant="soft"
          color="neutral"
          loading={busy}
          onClick={() => void grant()}
          data-testid="tool-access-grant-btn"
        >
          Share a folder
        </Button>
      </Stack>
    </Box>
  );
}
