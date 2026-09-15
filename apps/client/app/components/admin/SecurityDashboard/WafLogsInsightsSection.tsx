import { Box, LinearProgress, Sheet, Stack, Table, Typography, useTheme } from '@mui/joy';
import dynamic from 'next/dynamic';
import type { WafRangeInput } from '@/server/security/wafTraffic';
import type {
  SecurityDashboardWafLogsInsightsOverview,
  SecurityDashboardWafBlockedRequestsResult,
} from '@/app/hooks/data/admin';
import { useWafChartTheme } from './useWafChartTheme';
import { WafBlockedRequestsTable } from './WafBlockedRequestsTable';
import { formatRangeLabel } from './wafRangeLabel';

const ResponsiveBarChart = dynamic(() => import('@nivo/bar').then(mod => mod.ResponsiveBar), {
  ssr: false,
});

interface WafLogsInsightsSectionProps {
  data?: SecurityDashboardWafLogsInsightsOverview;
  range: WafRangeInput;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  blockedRequestsData?: SecurityDashboardWafBlockedRequestsResult;
  blockedRequestsLoading?: boolean;
  blockedRequestsError?: boolean;
  blockedRequestsErrorDetail?: unknown;
}

/** WAF log insights charts sourced from CloudWatch Logs Insights queries. */
export const WafLogsInsightsSection = ({
  data,
  range,
  isLoading,
  isError,
  error,
  blockedRequestsData,
  blockedRequestsLoading,
  blockedRequestsError,
  blockedRequestsErrorDetail,
}: WafLogsInsightsSectionProps) => {
  const theme = useTheme();
  const chartTheme = useWafChartTheme();

  return (
    <Box sx={{ mt: 2 }} data-testid="waf-logs-insights-section">
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
        <Typography level="title-sm" sx={{ fontWeight: 700 }}>
          WAF log insights (CloudWatch Logs)
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
          {formatRangeLabel(range)}
        </Typography>
      </Stack>

      {isLoading && (
        <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-logs-insights-loading">
          Loading WAF log insights…
        </Typography>
      )}

      {isError && (
        <Typography level="body-sm" sx={{ color: 'danger.500' }} data-testid="waf-logs-insights-error">
          Failed to load WAF log insights: {error instanceof Error ? error.message : String(error)}
          {'. Check CloudWatch logs for Lambda function with "WAF Logs Insights" in the output.'}
        </Typography>
      )}

      {data?.enabled === false && (
        <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-logs-insights-disabled-msg">
          {data.reason === 'no-logging-config'
            ? 'WAF logging is not configured for the Router WebACL (or the log destination could not be discovered). Enable CloudWatch logs on the WebACL to see these graphs.'
            : data.reason === 'no-webacl'
              ? 'No WebACL is attached to the Router CloudFront distribution for this stage, so log insights are unavailable.'
              : 'WAF log insights are currently unavailable for this stage.'}
        </Typography>
      )}

      {data?.enabled && (
        <>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
              gap: 2,
            }}
            data-testid="waf-logs-insights-grid"
          >
            {/* Top Blocked URIs Chart */}
            <Sheet
              variant="soft"
              sx={{ p: 2, borderRadius: 'lg', backgroundColor: 'background.level1' }}
              data-testid="waf-logs-top-blocked-uris-card"
            >
              <Typography level="title-sm" sx={{ fontWeight: 700, mb: 1 }}>
                Traffic characteristics • Top 10 blocked URIs
              </Typography>
              {(data.trafficCharacteristics?.topBlockedUris?.length ?? 0) === 0 ? (
                <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-logs-top-blocked-uris-empty">
                  No data available for the selected window.
                </Typography>
              ) : (
                <Box sx={{ height: 260 }} data-testid="waf-logs-top-blocked-uris-chart">
                  <ResponsiveBarChart
                    data={[...(data.trafficCharacteristics?.topBlockedUris ?? [])].reverse().map(x => ({
                      name: x.name,
                      count: Math.round(x.count),
                    }))}
                    keys={['count']}
                    indexBy="name"
                    layout="horizontal"
                    margin={{ top: 10, right: 12, bottom: 40, left: 160 }}
                    padding={0.35}
                    colors={[theme.palette.primary[500]]}
                    axisTop={null}
                    axisRight={null}
                    axisBottom={{
                      legend: 'Block count',
                      legendPosition: 'middle',
                      legendOffset: 32,
                    }}
                    axisLeft={{
                      legend: 'URI',
                      legendPosition: 'middle',
                      legendOffset: -135,
                    }}
                    enableLabel={false}
                    theme={chartTheme}
                  />
                </Box>
              )}
            </Sheet>

            {/* Top Client IPs by Location Chart */}
            <Sheet
              variant="soft"
              sx={{ p: 2, borderRadius: 'lg', backgroundColor: 'background.level1' }}
              data-testid="waf-logs-top-client-ips-card"
            >
              <Typography level="title-sm" sx={{ fontWeight: 700, mb: 1 }}>
                Traffic characteristics • Top 10 client IPs by location
              </Typography>
              {(data.trafficCharacteristics?.topClientIps?.length ?? 0) === 0 ? (
                <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-logs-top-client-ips-empty">
                  No data available for the selected window.
                </Typography>
              ) : (
                <Box sx={{ height: 260 }} data-testid="waf-logs-top-client-ips-chart">
                  <ResponsiveBarChart
                    data={[...(data.trafficCharacteristics?.topClientIps ?? [])].reverse().map(x => ({
                      name: x.name,
                      count: Math.round(x.count),
                    }))}
                    keys={['count']}
                    indexBy="name"
                    layout="horizontal"
                    margin={{ top: 10, right: 12, bottom: 40, left: 175 }}
                    padding={0.35}
                    colors={[theme.palette.warning[500] ?? '#9a5b13']}
                    axisTop={null}
                    axisRight={null}
                    axisBottom={{
                      legend: 'Requests',
                      legendPosition: 'middle',
                      legendOffset: 32,
                    }}
                    axisLeft={{
                      legend: 'Location • IP',
                      legendPosition: 'middle',
                      legendOffset: -155,
                    }}
                    enableLabel={false}
                    theme={chartTheme}
                  />
                </Box>
              )}
            </Sheet>
          </Box>

          {/* Rate Limit Usage - full width below the charts grid */}
          <Sheet
            variant="soft"
            sx={{ p: 2, borderRadius: 'lg', backgroundColor: 'background.level1', mt: 2 }}
            data-testid="waf-logs-rate-limit-card"
          >
            <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1.5 }}>
              <Typography level="title-sm" sx={{ fontWeight: 700 }}>
                Rate limit usage • Top 10 IP + URI
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                Peak per 5-min · {formatRangeLabel(range)} · Limit:{' '}
                {(data.managedRuleGroups?.rateLimitUsage?.limitPerWindow ?? 10000).toLocaleString()} req/IP
              </Typography>
            </Stack>

            {(data.managedRuleGroups?.rateLimitUsage?.topIps?.length ?? 0) === 0 ? (
              <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-logs-rate-limit-empty">
                No data available for the selected window.
              </Typography>
            ) : (
              <Box sx={{ overflowX: 'auto' }} data-testid="waf-logs-rate-limit-list">
                <Table
                  size="sm"
                  sx={{
                    '& thead th': { fontWeight: 700, fontSize: '0.72rem', whiteSpace: 'nowrap' },
                    '& tbody td': { fontSize: '0.72rem', verticalAlign: 'middle' },
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>IP</th>
                      <th>URI</th>
                      <th style={{ width: 160, textAlign: 'right' }}>Peak / Limit</th>
                      <th style={{ width: 180 }}>Usage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.managedRuleGroups?.rateLimitUsage?.topIps ?? []).map(item => {
                      const limit = data.managedRuleGroups?.rateLimitUsage?.limitPerWindow ?? 10000;
                      const peak = item.peakRequests ?? 0;
                      const pct = Math.min(100, (peak / limit) * 100);
                      const color = pct >= 80 ? 'danger' : pct >= 50 ? 'warning' : 'success';
                      return (
                        <tr key={`${item.ip}:${item.uri}`}>
                          <td>
                            <Typography level="body-xs" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                              {item.ip}
                            </Typography>
                          </td>
                          <td>
                            <Typography
                              level="body-xs"
                              sx={{
                                color: 'neutral.600',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: 320,
                              }}
                              title={item.uri}
                            >
                              {item.uri}
                            </Typography>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <Typography
                              level="body-xs"
                              sx={{ color: `${color}.500`, fontVariantNumeric: 'tabular-nums' }}
                            >
                              {peak.toLocaleString()} / {limit.toLocaleString()}
                            </Typography>
                          </td>
                          <td>
                            <LinearProgress
                              determinate
                              value={pct}
                              color={color}
                              size="sm"
                              sx={{ borderRadius: 'sm' }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </Box>
            )}
          </Sheet>
          <WafBlockedRequestsTable
            data={blockedRequestsData}
            range={range}
            isLoading={blockedRequestsLoading}
            isError={blockedRequestsError}
            error={blockedRequestsErrorDetail}
          />
        </>
      )}
    </Box>
  );
};
