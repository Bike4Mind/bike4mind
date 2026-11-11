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
      <CircularProgress size="sm" aria-hidden />
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        {label}
      </Typography>
    </Stack>
  );
}

/**
 * Thin progress row for a background refetch; existing data stays visible beneath it. Always
 * mounted at a fixed height so a poll toggling `active` neither shifts layout nor announces. The
 * test id is present only while active.
 *
 * `overlay` reserves no height: the bar floats in the region gap above its parent, which must be
 * `position: relative`. Use it when the bar would otherwise be its own item in a page stack, where
 * the reserved 20 px plus two region gaps leave a blank band.
 */
export function UpdatingBar({
  active,
  testId,
  placement = 'inline',
}: {
  active: boolean;
  testId?: string;
  placement?: 'inline' | 'overlay';
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      gap={1}
      aria-hidden={!active}
      sx={{
        ...adminFocusScope,
        height: 20,
        visibility: active ? 'visible' : 'hidden',
        ...(placement === 'overlay' && { position: 'absolute', left: 0, right: 0, bottom: '100%', mb: '2px' }),
      }}
      data-testid={active ? (testId ?? 'admin-updating-bar') : undefined}
    >
      <LinearProgress size="sm" aria-hidden sx={{ flex: 1 }} />
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        Updating
      </Typography>
    </Stack>
  );
}
