import { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { formatErrorDetails, summarizeError } from './renderError';

type CopyState = 'idle' | 'copied' | 'failed';

export type AppErrorFallbackProps = {
  error: unknown;
  componentStack?: string | null;
  /** Injected for tests; a real reload is the recovery, since in-memory state may be what broke. */
  reload?: () => void;
};

/** What a render error leaves on screen instead of a blank window. */
export function AppErrorFallback({
  error,
  componentStack,
  reload = () => window.location.reload(),
}: AppErrorFallbackProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const { message } = summarizeError(error);

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(formatErrorDetails(error, componentStack));
      setCopyState('copied');
    } catch (copyError: unknown) {
      console.warn('Could not copy the error details', copyError);
      setCopyState('failed');
    }
  };

  return (
    <Box
      role="alert"
      data-testid="app-error-fallback"
      sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 3, bgcolor: 'background.body' }}
    >
      <Card variant="outlined" sx={{ maxWidth: 480, width: '100%', gap: 1.5 }}>
        <Typography level="title-lg">Something went wrong</Typography>
        <Typography level="body-sm">
          Bike4Mind hit an unexpected error while drawing this window. Reloading redraws it; your chats are kept.
        </Typography>
        <Typography
          level="body-xs"
          data-testid="app-error-message"
          sx={{ fontFamily: 'code', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}
        >
          {message}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button variant="plain" color="neutral" onClick={() => void copyDetails()} data-testid="app-error-copy-btn">
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy details'}
          </Button>
          <Button onClick={reload} data-testid="app-error-reload-btn">
            Reload
          </Button>
        </Stack>
      </Card>
    </Box>
  );
}
