import { Box, Button, Input, Sheet, Stack, Typography } from '@mui/joy';
import { useState } from 'react';
import {
  useSecurityDashboardWafTraffic,
  useSecurityDashboardWafLogsInsights,
  useSecurityDashboardWafBlockedRequests,
  type WafTrafficRange,
  type WafRangeInput,
} from '@/app/hooks/data/admin';
import { isCustomRange } from '@/server/security/wafSharedHelpers';
import { WafTopRulesChart } from './WafTopRulesChart';
import { WafTrafficGauge } from './WafTrafficGauge';
import { WafLogsInsightsSection } from './WafLogsInsightsSection';

/** Convert a Date to the value format expected by datetime-local inputs (YYYY-MM-DDTHH:mm). */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * WAF traffic metrics overview (CloudWatch Metrics + Logs Insights): totals, action-totals and
 * top-blocked-rules time series, and log insights. Rendered independently of the WAF security scan
 * snapshot, so live traffic shows even when no posture scan has run.
 *
 * @param isActive - When true, queries fire; the WAF tab gates this to avoid needless calls.
 */
export const WafTrafficOverview = ({ isActive = true }: { isActive?: boolean }) => {
  const [trafficRange, setTrafficRange] = useState<WafRangeInput>('24h');
  const [showCustomPicker, setShowCustomPicker] = useState(false);

  // Default custom picker window: last 24 hours
  const defaultEnd = new Date();
  const defaultStart = new Date(defaultEnd.getTime() - 24 * 60 * 60 * 1000);
  const [customStart, setCustomStart] = useState(toDatetimeLocalValue(defaultStart));
  const [customEnd, setCustomEnd] = useState(toDatetimeLocalValue(defaultEnd));
  const [customError, setCustomError] = useState<string | null>(null);

  // Single query returns totals, series, and topBlockedRulesSeries together;
  // includeRules adds the top-10 blocked rules series with negligible overhead.
  const trafficQuery = useSecurityDashboardWafTraffic({
    range: trafficRange,
    includeRules: true,
    enabled: isActive,
  });
  const logsInsightsQuery = useSecurityDashboardWafLogsInsights({
    range: trafficRange,
    enabled: isActive,
  });
  const blockedRequestsQuery = useSecurityDashboardWafBlockedRequests({
    range: trafficRange,
    enabled: isActive,
  });

  const handleApplyCustom = () => {
    const start = new Date(customStart);
    const end = new Date(customEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setCustomError('Please enter valid dates.');
      return;
    }
    if (start >= end) {
      setCustomError('Start must be before end.');
      return;
    }
    setCustomError(null);
    setShowCustomPicker(false);
    setTrafficRange({ start: start.toISOString(), end: end.toISOString() });
  };

  const handlePresetRange = (range: WafTrafficRange) => {
    setShowCustomPicker(false);
    setCustomError(null);
    setTrafficRange(range);
  };

  return (
    <Sheet
      variant="outlined"
      sx={{
        p: 2,
        borderRadius: 'md',
      }}
      data-testid="waf-traffic-overview-card"
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
            Traffic overview (Router WebACL)
          </Typography>
          <Typography level="title-md" sx={{ fontWeight: 700 }}>
            {trafficQuery.data?.enabled === false
              ? 'No WebACL attached for this stage'
              : trafficQuery.isLoading
                ? 'Loading traffic metrics…'
                : 'Action totals'}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" justifyContent="flex-end">
          <Button
            size="sm"
            variant={trafficRange === '1h' ? 'solid' : 'soft'}
            color="neutral"
            onClick={() => handlePresetRange('1h')}
            data-testid="waf-traffic-range-1h-btn"
            sx={{ textTransform: 'none' }}
          >
            1h
          </Button>
          <Button
            size="sm"
            variant={trafficRange === '24h' ? 'solid' : 'soft'}
            color="neutral"
            onClick={() => handlePresetRange('24h')}
            data-testid="waf-traffic-range-24h-btn"
            sx={{ textTransform: 'none' }}
          >
            24h
          </Button>
          <Button
            size="sm"
            variant={trafficRange === '7d' ? 'solid' : 'soft'}
            color="neutral"
            onClick={() => handlePresetRange('7d')}
            data-testid="waf-traffic-range-7d-btn"
            sx={{ textTransform: 'none' }}
          >
            7d
          </Button>
          <Button
            size="sm"
            variant={isCustomRange(trafficRange) || showCustomPicker ? 'solid' : 'soft'}
            color="neutral"
            onClick={() => setShowCustomPicker(v => !v)}
            data-testid="waf-traffic-range-custom-btn"
            sx={{ textTransform: 'none' }}
          >
            Custom
          </Button>
          <Button
            size="sm"
            variant="soft"
            color="primary"
            onClick={() => trafficQuery.refetch()}
            disabled={trafficQuery.isFetching}
            data-testid="waf-traffic-refresh-btn"
            sx={{ textTransform: 'none' }}
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      {showCustomPicker && (
        <Sheet
          variant="soft"
          sx={{
            mt: 1.5,
            p: 1.5,
            borderRadius: 'sm',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            alignItems: 'flex-end',
          }}
          data-testid="waf-traffic-custom-picker"
        >
          <Box>
            <Typography level="body-xs" sx={{ mb: 0.5, color: 'neutral.600' }}>
              From
            </Typography>
            <Input
              size="sm"
              type="datetime-local"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              slotProps={{ input: { 'data-testid': 'waf-custom-start-input' } }}
            />
          </Box>
          <Box>
            <Typography level="body-xs" sx={{ mb: 0.5, color: 'neutral.600' }}>
              To
            </Typography>
            <Input
              size="sm"
              type="datetime-local"
              value={customEnd}
              onChange={e => setCustomEnd(e.target.value)}
              slotProps={{ input: { 'data-testid': 'waf-custom-end-input' } }}
            />
          </Box>
          <Button
            size="sm"
            variant="solid"
            color="primary"
            onClick={handleApplyCustom}
            data-testid="waf-custom-apply-btn"
            sx={{ textTransform: 'none' }}
          >
            Apply
          </Button>
          {customError && (
            <Typography level="body-xs" sx={{ color: 'danger.600', alignSelf: 'center' }}>
              {customError}
            </Typography>
          )}
        </Sheet>
      )}

      {trafficQuery.data?.enabled && trafficQuery.data.totals && (
        <Box
          sx={{
            mt: 2,
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
            gap: 2,
          }}
          data-testid="waf-traffic-charts-grid"
        >
          <WafTrafficGauge
            allowed={Math.round(trafficQuery.data.totals?.allowed ?? 0)}
            blocked={Math.round(trafficQuery.data.totals?.blocked ?? 0)}
            counted={Math.round(trafficQuery.data.totals?.counted ?? 0)}
          />

          {trafficQuery.data?.topBlockedRulesSeries && (
            <WafTopRulesChart
              data={trafficQuery.data.topBlockedRulesSeries}
              range={trafficRange}
              isLoading={trafficQuery.isLoading}
            />
          )}
        </Box>
      )}

      {trafficQuery.data?.enabled && (
        <WafLogsInsightsSection
          data={logsInsightsQuery.data}
          range={trafficRange}
          isLoading={logsInsightsQuery.isLoading}
          isError={logsInsightsQuery.isError}
          error={logsInsightsQuery.error}
          blockedRequestsData={blockedRequestsQuery.data}
          blockedRequestsLoading={blockedRequestsQuery.isLoading}
          blockedRequestsError={blockedRequestsQuery.isError}
          blockedRequestsErrorDetail={blockedRequestsQuery.error}
        />
      )}

      {trafficQuery.data?.enabled === false && (
        <Typography level="body-sm" sx={{ color: 'neutral.600', mt: 1.5 }} data-testid="waf-traffic-disabled-msg">
          No WebACL is attached to the Router CloudFront distribution for this stage, so traffic metrics are
          unavailable.
        </Typography>
      )}

      {trafficQuery.isError && (
        <Typography level="body-sm" sx={{ color: 'danger.600', mt: 1.5 }} data-testid="waf-traffic-error-msg">
          Unable to load WAF traffic metrics for this stage.
        </Typography>
      )}
    </Sheet>
  );
};
