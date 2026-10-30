import { adminFocusScope } from './adminStyles';
import { Button, Stack, Typography } from '@mui/joy';
export function ErrorState({
  message,
  onRetry,
  onFirstPage,
}: {
  message: string;
  onRetry: () => void;
  onFirstPage?: () => void;
}) {
  return (
    <Stack role="alert" alignItems="center" gap={1} sx={{ ...adminFocusScope, p: 3 }} data-testid="admin-error-state">
      <Typography sx={{ color: 'admin.danger' }}>{message}</Typography>
      <Button variant="outlined" onClick={onRetry} data-testid="admin-error-retry-btn">
        Try again
      </Button>
      {onFirstPage && (
        <Button variant="plain" onClick={onFirstPage} data-testid="admin-error-first-page-btn">
          Back to the first page
        </Button>
      )}
    </Stack>
  );
}
