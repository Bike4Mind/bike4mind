import { Link, Stack, Typography } from '@mui/joy';

/** Under a picker whose options failed to load: says so in place and asks again on Retry. */
export function PickerLoadError({
  message,
  onRetry,
  retrying,
  'data-testid': testId,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
  'data-testid': string;
}) {
  return (
    <Stack direction="row" gap={1} alignItems="baseline" flexWrap="wrap" sx={{ mt: 0.5 }} data-testid={testId}>
      <Typography level="body-xs" sx={{ color: 'admin.danger' }}>
        {message}
      </Typography>
      <Link
        component="button"
        type="button"
        level="body-xs"
        disabled={retrying}
        onClick={onRetry}
        data-testid={`${testId}-retry-btn`}
      >
        Retry
      </Link>
    </Stack>
  );
}
