import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';

/**
 * The +adds -dels pair, green and red like a diff gutter; grey when `muted`. Shared by the PR bar
 * and the changes bar so the two read as the same figure before and after a PR exists.
 */
export function DiffCount({
  added,
  removed,
  muted = false,
  testId,
}: {
  added: number;
  removed: number;
  muted?: boolean;
  testId?: string;
}) {
  return (
    <Typography level="body-xs" sx={{ fontFamily: 'code', whiteSpace: 'nowrap' }} data-testid={testId}>
      <Box component="span" sx={{ color: muted ? 'text.tertiary' : 'success.plainColor' }}>{`+${added}`}</Box>{' '}
      <Box component="span" sx={{ color: muted ? 'text.tertiary' : 'danger.plainColor' }}>{`-${removed}`}</Box>
    </Typography>
  );
}
