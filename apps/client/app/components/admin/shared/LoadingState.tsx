import { adminFocusScope } from './adminStyles';
import { CircularProgress, LinearProgress, Stack, Typography } from '@mui/joy';

export function LoadingState({ label, testId }: { label: string; testId?: string }) {
  return (
    <Stack
      role="status"
      aria-live="polite"
      alignItems="center"
      gap={1}
      sx={{ ...adminFocusScope, p: 3 }}
      data-testid={testId ?? 'admin-loading-state'}
    >
      <CircularProgress size="sm" />
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        {label}
      </Typography>
    </Stack>
  );
}

/** Thin progress row for a background refetch; existing data stays visible beneath it. */
export function UpdatingBar({ testId }: { testId?: string }) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      gap={1}
      role="status"
      sx={adminFocusScope}
      data-testid={testId ?? 'admin-updating-bar'}
    >
      <LinearProgress size="sm" sx={{ flex: 1 }} />
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        Updating
      </Typography>
    </Stack>
  );
}
