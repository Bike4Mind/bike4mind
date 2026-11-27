import { useEffect, useState } from 'react';
import Snackbar from '@mui/joy/Snackbar';
import Typography from '@mui/joy/Typography';
import { hostClient } from '../host/HostClient';

interface SpawnFailure {
  title: string;
  message: string;
}

/**
 * Reports a startup failure whichever conversation is open. The message explains whether
 * the failed session was removed or kept to preserve accepted input (ChatService.abandonSpawn).
 */
export function SpawnFailureToast() {
  const [failure, setFailure] = useState<SpawnFailure | null>(null);

  // Host-wide, since nothing is subscribed to a session that never started. A failure while
  // disconnected is not replayed; the session list, re-read on reconnect, shows the outcome.
  useEffect(
    () => hostClient.onNotification('session/spawnFailed', ({ title, message }) => setFailure({ title, message })),
    []
  );

  return (
    <Snackbar
      open={failure !== null}
      onClose={() => setFailure(null)}
      autoHideDuration={8000}
      color="danger"
      variant="soft"
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      data-testid="spawn-failure-toast"
    >
      {failure && (
        <div>
          <Typography level="title-sm" textColor="inherit">
            {`"${failure.title}" could not start`}
          </Typography>
          <Typography level="body-sm" textColor="inherit">
            {failure.message}
          </Typography>
        </div>
      )}
    </Snackbar>
  );
}
