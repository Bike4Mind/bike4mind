import { Box, Sheet, Stack, Typography, useTheme } from '@mui/joy';
import dynamic from 'next/dynamic';
import type { ComponentProps } from 'react';
import type { ResponsivePie } from '@nivo/pie';

type ResponsivePieProps = ComponentProps<typeof ResponsivePie>;

const ResponsivePieChart = dynamic(() => import('@nivo/pie').then(m => ({ default: m.ResponsivePie })), {
  ssr: false,
}) as React.ComponentType<ResponsivePieProps>;

interface WafTrafficGaugeProps {
  allowed: number;
  blocked: number;
  counted: number;
}

interface MiniDonutProps {
  value: number;
  total: number;
  fillColor: string;
  trackColor: string;
  label: string;
  labelColor: string;
  testIdPrefix: string;
}

const MiniDonut = ({ value, total, fillColor, trackColor, label, labelColor, testIdPrefix }: MiniDonutProps) => {
  const theme = useTheme();
  const textColor = theme.palette.text.primary;
  const subTextColor =
    theme.palette.mode === 'dark'
      ? (theme.palette.neutral[400] ?? '#9fa6ad')
      : (theme.palette.neutral[500] ?? '#636b74');

  const rate = total > 0 ? (value / total) * 100 : 0;

  const data =
    total > 0
      ? [
          { id: 'value', label, value, color: fillColor },
          { id: 'track', label: '', value: total - value, color: trackColor },
        ]
      : [{ id: 'empty', label: 'No data', value: 1, color: trackColor }];

  return (
    <Box sx={{ textAlign: 'center', flex: 1 }}>
      <Box sx={{ position: 'relative', height: 130 }} data-testid={`${testIdPrefix}-chart`}>
        <ResponsivePieChart
          data={data}
          colors={d => (d.data as { color: string }).color}
          innerRadius={0.72}
          padAngle={total > 0 ? 2 : 0}
          cornerRadius={3}
          startAngle={-180}
          endAngle={180}
          enableArcLabels={false}
          enableArcLinkLabels={false}
          isInteractive={false}
          animate={true}
          motionConfig="gentle"
        />

        {/* Center overlay */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          {total > 0 ? (
            <>
              <Typography
                sx={{
                  fontSize: '1.15rem',
                  fontWeight: 800,
                  lineHeight: 1,
                  color: fillColor,
                }}
                data-testid={`${testIdPrefix}-rate`}
              >
                {rate.toFixed(1)}%
              </Typography>
              <Typography sx={{ fontSize: '0.6rem', color: subTextColor, mt: 0.25 }}>of total</Typography>
            </>
          ) : (
            <Typography sx={{ fontSize: '0.7rem', color: subTextColor }}>No data</Typography>
          )}
        </Box>
      </Box>

      <Typography
        level="title-sm"
        sx={{ fontWeight: 700, color: labelColor, mt: 0.25 }}
        data-testid={`${testIdPrefix}-label`}
      >
        {label}
      </Typography>
      <Typography level="body-xs" sx={{ color: textColor, fontWeight: 600 }} data-testid={`${testIdPrefix}-count`}>
        {(value ?? 0).toLocaleString()} req
      </Typography>
    </Box>
  );
};

export const WafTrafficGauge = ({ allowed, blocked, counted }: WafTrafficGaugeProps) => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const total = allowed + blocked + counted;
  const trackColor = isDark ? (theme.palette.neutral[700] ?? '#32383e') : (theme.palette.neutral[200] ?? '#dde7ee');

  const allowedFill = theme.palette.success[500] ?? '#1f7a1f';
  const blockedFill = theme.palette.danger[500] ?? '#c41c1c';
  const allowedLabel = theme.palette.success[600] ?? '#185c18';
  const blockedLabel = theme.palette.danger[600] ?? '#932020';
  const subTextColor = isDark ? (theme.palette.neutral[400] ?? '#9fa6ad') : (theme.palette.neutral[500] ?? '#636b74');

  return (
    <Sheet
      variant="soft"
      sx={{ p: 2, borderRadius: 'lg', backgroundColor: 'background.level1', display: 'flex', flexDirection: 'column' }}
      data-testid="waf-traffic-gauge-card"
    >
      <Typography level="title-sm" sx={{ fontWeight: 700, mb: 1 }}>
        Traffic Requests
      </Typography>

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <Stack direction="row" spacing={1} data-testid="waf-traffic-gauge-chart">
          <MiniDonut
            value={allowed}
            total={total}
            fillColor={allowedFill}
            trackColor={trackColor}
            label="Allowed"
            labelColor={allowedLabel}
            testIdPrefix="waf-gauge-allowed-donut"
          />
          <MiniDonut
            value={blocked}
            total={total}
            fillColor={blockedFill}
            trackColor={trackColor}
            label="Blocked"
            labelColor={blockedLabel}
            testIdPrefix="waf-gauge-blocked-donut"
          />
        </Stack>

        {/* Total row */}
        <Box sx={{ textAlign: 'center', mt: 1, borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
          <Typography level="body-xs" sx={{ color: subTextColor }}>
            Total requests
          </Typography>
          <Typography level="title-sm" sx={{ fontWeight: 700 }} data-testid="waf-gauge-total">
            {total.toLocaleString()}
          </Typography>
        </Box>
      </Box>
    </Sheet>
  );
};
