import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { UsageBreakdownRow } from '@shared/usage';
import { barPercent, formatCount, formatCredits } from './usageView';

/**
 * One breakdown cut: what the window's credits went on, biggest first.
 *
 * Credits, not provider cost: credits are the denomination the balance is in, so they are the
 * only figure here that answers "how much of mine did this take".
 */
export function UsageBreakdown({
  title,
  caption,
  rows,
  testId,
}: {
  title: string;
  caption: string;
  rows: UsageBreakdownRow[];
  testId: string;
}) {
  const max = rows.reduce((highest, row) => Math.max(highest, row.creditsSpent), 0);

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', px: 2, py: 1.5, mb: 1.5 }} data-testid={testId}>
      <Typography level="title-sm">{title}</Typography>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1 }}>
        {caption}
      </Typography>

      {rows.length === 0 ? (
        <Typography level="body-sm" textColor="text.tertiary" data-testid={`${testId}-empty`}>
          Nothing recorded in this window.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {rows.map(row => (
            <Box key={row.key} data-testid={`${testId}-row`}>
              <Stack direction="row" alignItems="baseline" spacing={1}>
                <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>
                  {row.label}
                </Typography>
                {row.detail && (
                  <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {row.detail}
                  </Typography>
                )}
                <Box sx={{ flex: row.detail ? 0 : 1 }} />
                <Typography level="body-xs" textColor="text.tertiary">
                  {formatCount(row.requests)} req
                </Typography>
                <Typography level="body-sm">{formatCredits(row.creditsSpent)}</Typography>
              </Stack>
              <Box sx={{ height: 4, borderRadius: 'sm', bgcolor: 'neutral.softBg', mt: 0.5 }}>
                <Box
                  sx={{
                    height: '100%',
                    width: `${barPercent(row.creditsSpent, max)}%`,
                    borderRadius: 'sm',
                    bgcolor: 'primary.solidBg',
                  }}
                />
              </Box>
            </Box>
          ))}
        </Stack>
      )}
    </Sheet>
  );
}
