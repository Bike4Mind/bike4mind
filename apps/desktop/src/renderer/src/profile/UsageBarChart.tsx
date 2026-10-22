import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { UsageBar, UsageGranularity } from '@shared/usage';
import { barPercent, bucketLabel, bucketTitle, tickIndices } from './usageView';

const PLOT_HEIGHT = 132;

export interface UsageBarChartProps {
  title: string;
  /** The window total, already formatted - the chart states what it draws. */
  total: string;
  bars: UsageBar[];
  granularity: UsageGranularity;
  metric: 'creditsSpent' | 'requests';
  /** Joy palette family the bars are painted from, so both modes are covered by the theme. */
  color: 'primary' | 'neutral';
  /** Formats one bar's value for the hover. */
  format: (value: number) => string;
  /** What to say when every bar in the window is zero. Not an error - the account spent nothing. */
  emptyMessage: string;
  testId: string;
}

/**
 * One window of spend as bars, in the shape macOS Settings draws a battery history.
 *
 * Hand-rolled out of Box rather than drawn by a charting library: the figure is a row of
 * rectangles against a baseline, and a chart dependency is a large thing to carry into a
 * desktop bundle for it. Bars are painted from the palette families rather than fixed colours
 * so light and dark are the theme's problem, not this file's.
 */
export function UsageBarChart({
  title,
  total,
  bars,
  granularity,
  metric,
  color,
  format,
  emptyMessage,
  testId,
}: UsageBarChartProps) {
  const max = bars.reduce((highest, bar) => Math.max(highest, bar[metric]), 0);
  const ticks = new Set(tickIndices(bars, granularity));

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', px: 2, py: 1.5, mb: 1.5 }} data-testid={testId}>
      <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1 }}>
          {title}
        </Typography>
        <Typography level="body-sm" textColor="text.tertiary" data-testid={`${testId}-total`}>
          {total}
        </Typography>
      </Stack>

      {max === 0 ? (
        <Box sx={{ height: PLOT_HEIGHT, display: 'grid', placeItems: 'center' }} data-testid={`${testId}-empty`}>
          <Typography level="body-sm" textColor="text.tertiary">
            {emptyMessage}
          </Typography>
        </Box>
      ) : (
        <Box
          sx={{
            height: PLOT_HEIGHT,
            display: 'flex',
            alignItems: 'flex-end',
            gap: '2px',
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          {bars.map(bar => (
            <Tooltip
              key={bar.startsAt}
              size="sm"
              variant="soft"
              title={`${bucketTitle(bar.startsAt, granularity)} - ${format(bar[metric])}`}
            >
              {/* The track is full height and the bar grows inside it, so every bucket keeps a
                  hover target even when it spent nothing. */}
              <Box sx={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
                <Box
                  sx={{
                    width: '100%',
                    height: `${barPercent(bar[metric], max)}%`,
                    minHeight: bar[metric] > 0 ? '2px' : 0,
                    borderRadius: '2px 2px 0 0',
                    bgcolor: `${color}.solidBg`,
                  }}
                />
              </Box>
            </Tooltip>
          ))}
        </Box>
      )}

      {/* Labels overflow their cell rather than being clipped to it: a bar is narrower than
          its own label, and a label cut to bar width leaves the axis unreadable. */}
      <Box sx={{ display: 'flex', gap: '2px', mt: 0.5 }}>
        {bars.map((bar, index) => (
          <Box key={bar.startsAt} sx={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
            {ticks.has(index) && (
              <Typography level="body-xs" textColor="text.tertiary" sx={{ fontSize: '10px', whiteSpace: 'nowrap' }}>
                {bucketLabel(bar.startsAt, granularity)}
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </Sheet>
  );
}
