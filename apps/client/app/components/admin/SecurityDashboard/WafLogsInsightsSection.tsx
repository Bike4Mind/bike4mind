import { Box, LinearProgress, Sheet, Stack, Typography } from '@mui/joy';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DataTable } from '../shared';
import type { WafRangeInput } from '@bike4mind/server-utils/security/wafTraffic';
import type {
  SecurityDashboardWafLogsInsightsOverview,
  SecurityDashboardWafBlockedRequestsResult,
} from '@/app/hooks/data/admin';
import { ChartTooltipCard } from '@client/app/components/Charts/chartStyle';
import { adminChartSeries, adminChartStyle } from '../EventMetrics/utils/chartTheme';
import { WafBlockedRequestsTable } from './WafBlockedRequestsTable';
import { formatRangeLabel } from './wafRangeLabel';

type TopItem = { name: string; count: number };

/** Horizontal bars, largest at the top (the order the server sends). Fills its parent. */
const TopItemsBarChart = ({
  testId,
  items,
  color,
  valueLegend,
  nameLegend,
  nameWidth,
}: {
  testId: string;
  items: readonly TopItem[];
  color: string;
  valueLegend: string;
  nameLegend: string;
  /** Room for the name ticks and legend, in px. */
  nameWidth: number;
}) => {
  const rows = items.map(x => ({ name: x.name, count: Math.round(x.count) }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* recharts takes the gap on each side of a bar, so 17.5% leaves the bar 65% of its band. */}
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
        barCategoryGap="17.5%"
      >
        <CartesianGrid
          horizontal={false}
          stroke={adminChartStyle.gridStroke}
          strokeDasharray={adminChartStyle.gridDash}
        />
        <XAxis
          type="number"
          domain={[0, 'auto']}
          height={40}
          tick={adminChartStyle.tick}
          tickLine={adminChartStyle.tickLine}
          tickSize={5}
          axisLine={false}
          label={{ value: valueLegend, position: 'insideBottom', offset: 0, style: adminChartStyle.axisLabel }}
        />
        <YAxis
          type="category"
          dataKey="name"
          interval={0}
          width={nameWidth}
          tick={adminChartStyle.tick}
          tickLine={adminChartStyle.tickLine}
          tickSize={5}
          axisLine={false}
          label={{
            value: nameLegend,
            angle: -90,
            position: 'insideLeft',
            offset: 10,
            style: { ...adminChartStyle.axisLabel, textAnchor: 'middle' },
          }}
        />
        <Tooltip
          shared={false}
          cursor={false}
          content={({ active, payload }) => {
            const row = payload?.[0]?.payload as TopItem | undefined;
            if (!active || !row) return null;
            return (
              <ChartTooltipCard
                testId={`${testId}-tooltip`}
                color={color}
                label={`count - ${row.name}`}
                value={row.count}
              />
            );
          }}
        />
        <Bar dataKey="count" fill={color} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
};

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
  onRetry?(): void;
  onRetryBlockedRequests?(): void;
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
  onRetry = () => {},
  onRetryBlockedRequests,
}: WafLogsInsightsSectionProps) => {
  const [uriColor, ipColor] = adminChartSeries(2);

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
                  <TopItemsBarChart
                    testId="waf-logs-top-blocked-uris-chart"
                    items={data.trafficCharacteristics?.topBlockedUris ?? []}
                    color={uriColor}
                    valueLegend="Block count"
                    nameLegend="URI"
                    nameWidth={160}
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
                  <TopItemsBarChart
                    testId="waf-logs-top-client-ips-chart"
                    items={data.trafficCharacteristics?.topClientIps ?? []}
                    color={ipColor}
                    valueLegend="Requests"
                    nameLegend={'Location \u{2022} IP'}
                    nameWidth={175}
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
                <DataTable
                  rows={data.managedRuleGroups?.rateLimitUsage?.topIps ?? []}
                  getRowId={item => `${item.ip}:${item.uri}`}
                  label="Rate limit usage"
                  onRetry={onRetry}
                  pageResetKey={JSON.stringify(range)}
                  columns={[
                    { id: 'ip', label: 'IP', render: item => item.ip },
                    {
                      id: 'uri',
                      label: 'URI',
                      wrap: true,
                      render: item => <Typography sx={{ overflowWrap: 'anywhere' }}>{item.uri}</Typography>,
                    },
                    {
                      id: 'peak',
                      label: 'Peak / limit',
                      numeric: true,
                      render: item =>
                        `${(item.peakRequests ?? 0).toLocaleString()} / ${(data.managedRuleGroups?.rateLimitUsage?.limitPerWindow ?? 10000).toLocaleString()}`,
                    },
                    {
                      id: 'usage',
                      label: 'Usage',
                      render: item => (
                        <LinearProgress
                          determinate
                          value={Math.min(
                            100,
                            ((item.peakRequests ?? 0) /
                              (data.managedRuleGroups?.rateLimitUsage?.limitPerWindow ?? 10000)) *
                              100
                          )}
                          color="neutral"
                        />
                      ),
                    },
                  ]}
                />
              </Box>
            )}
          </Sheet>
          <WafBlockedRequestsTable
            data={blockedRequestsData}
            range={range}
            isLoading={blockedRequestsLoading}
            isError={blockedRequestsError}
            error={blockedRequestsErrorDetail}
            onRetry={onRetryBlockedRequests}
          />
        </>
      )}
    </Box>
  );
};
