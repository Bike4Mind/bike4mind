import { Box, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import dynamic from 'next/dynamic';
import type { WafRangeInput, WafTrafficSeries } from '@/server/security/wafTraffic';
import { useWafChartTheme } from './useWafChartTheme';
import { formatChartAxisDate } from './chartUtils';
import { formatRangeLabel } from './wafRangeLabel';

const ResponsiveLineChart = dynamic(() => import('@nivo/line').then(mod => mod.ResponsiveLine), {
  ssr: false,
});

interface WafActionTotalsChartProps {
  series: WafTrafficSeries;
  range: WafRangeInput;
}

/**
 * Displays a time-series line chart of WAF action totals (Allowed vs. Blocked requests).
 * Used within the WAF Traffic Overview card.
 */
export const WafActionTotalsChart = ({ series, range }: WafActionTotalsChartProps) => {
  const theme = useTheme();
  const chartTheme = useWafChartTheme();

  return (
    <Sheet
      variant="soft"
      sx={{
        p: 2,
        borderRadius: 'lg',
        backgroundColor: 'background.level1',
      }}
      data-testid="waf-traffic-action-totals-card"
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        sx={{ mb: 1 }}
      >
        <Typography level="title-sm" sx={{ fontWeight: 700 }}>
          Action totals
        </Typography>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" justifyContent="flex-end">
          <Stack direction="row" spacing={0.75} alignItems="center" data-testid="waf-traffic-action-totals-legend">
            <Box sx={{ width: 10, height: 10, borderRadius: 99, bgcolor: theme.palette.success[500] }} />
            <Typography level="body-xs" sx={{ color: 'neutral.300' }}>
              Allowed
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Box sx={{ width: 10, height: 10, borderRadius: 99, bgcolor: theme.palette.danger[500] }} />
            <Typography level="body-xs" sx={{ color: 'neutral.300' }}>
              Blocked
            </Typography>
          </Stack>
          <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
            {formatRangeLabel(range)}
          </Typography>
        </Stack>
      </Stack>

      <Box sx={{ height: 260 }} data-testid="waf-traffic-action-totals-chart">
        <ResponsiveLineChart
          data={[
            {
              id: 'Allowed',
              data: series.timestamps.map((ts, idx) => ({
                x: new Date(ts),
                y: series.allowed?.[idx] ?? 0,
              })),
            },
            {
              id: 'Blocked',
              data: series.timestamps.map((ts, idx) => ({
                x: new Date(ts),
                y: series.blocked?.[idx] ?? 0,
              })),
            },
          ]}
          margin={{ top: 10, right: 12, bottom: 66, left: 58 }}
          xScale={{
            type: 'time',
            format: 'native',
            useUTC: true,
            precision: 'minute',
          }}
          yScale={{ type: 'linear', min: 0, max: 'auto' }}
          axisTop={null}
          axisRight={null}
          axisBottom={{
            format: formatChartAxisDate,
            tickRotation: -15,
            legend: 'Time (UTC)',
            legendPosition: 'middle',
            legendOffset: 54,
          }}
          axisLeft={{
            legend: 'Requests',
            legendPosition: 'middle',
            legendOffset: -44,
          }}
          curve="monotoneX"
          colors={[theme.palette.success[500], theme.palette.danger[500]]}
          pointSize={0}
          enablePoints={false}
          useMesh={true}
          enableArea={false}
          gridYValues={5}
          theme={chartTheme}
        />
      </Box>
    </Sheet>
  );
};
