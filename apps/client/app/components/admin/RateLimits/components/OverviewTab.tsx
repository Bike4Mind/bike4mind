import React from 'react';
import { Box, Sheet, Stack, Table, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { RATE_LIMIT_INTEGRATIONS } from '@bike4mind/common';
import type { ChartData, RateLimitSnapshot } from '../types';
import { EmptyState, SectionCard, StatusChip } from '../../shared';

const INTEGRATION_COLORS: Record<string, string> = {
  github: '#8884d8',
  jira: '#0052CC',
  confluence: '#36B37E',
  slack: '#E01E5A',
};

function formatResetTime(resetAt: string): string {
  const resetDate = new Date(resetAt);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  if (diffMs <= 0) return 'Reset';
  const diffMin = Math.ceil(diffMs / 60000);
  if (diffMin < 60) return `Resets in ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  const remainMin = diffMin % 60;
  return `Resets in ${diffHr}h ${remainMin}m`;
}

interface OverviewTabProps {
  chartData: ChartData;
  snapshots: RateLimitSnapshot[];
  /** The empty state's call to action. */
  emptyAction: React.ReactNode;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ chartData, snapshots, emptyAction }) => {
  const theme = useTheme();

  const recentThrottled = snapshots.filter(s => s.wasThrottled).slice(0, 20);

  // Only render chart lines for integrations that have data points
  const activeIntegrations = RATE_LIMIT_INTEGRATIONS.filter(key =>
    chartData.usageTimeSeries.some(point => (point[key] as number) > 0)
  );

  return (
    <Stack gap={2}>
      {chartData.integrationSummaries.length > 0 && (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))' }}>
          {chartData.integrationSummaries.map(summary => (
            <SectionCard
              key={summary.integration}
              title={summary.integration.charAt(0).toUpperCase() + summary.integration.slice(1)}
              body="custom"
              data-testid={`rate-limit-integration-${summary.integration}`}
              action={
                <Stack direction="row" gap={0.5}>
                  {summary.avgUsagePercent >= 80 && <StatusChip tone="warn" label="Near limit" />}
                  {summary.throttledCount > 0 && <StatusChip tone="bad" label="Throttled" />}
                </Stack>
              }
            >
              <Stack gap={0.5} sx={{ px: 2, py: 1.75 }}>
                <Typography
                  sx={{ color: 'admin.ink', fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                >
                  {summary.latestRemaining !== null ? summary.latestRemaining : '--'}
                  <Typography level="body-sm" component="span" sx={{ color: 'admin.inkMuted', fontWeight: 400 }}>
                    {summary.latestLimit !== null ? ` / ${summary.latestLimit}` : ''}
                  </Typography>
                </Typography>
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                  {summary.avgUsagePercent}% avg usage | {summary.throttledCount} throttled
                </Typography>
                {summary.latestResetAt && new Date(summary.latestResetAt) > new Date() && (
                  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                    {formatResetTime(summary.latestResetAt)}
                  </Typography>
                )}
              </Stack>
            </SectionCard>
          ))}
        </Box>
      )}

      {/* Usage over time chart */}
      {chartData.usageTimeSeries.length > 0 && (
        <Sheet
          data-testid="rate-limit-chart-container"
          variant="outlined"
          sx={{ p: 2, borderRadius: 'lg', bgcolor: 'admin.surface', borderColor: 'admin.border' }}
        >
          <Typography level="title-md" sx={{ mb: 2, color: 'admin.ink' }}>
            Usage over time (%)
          </Typography>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData.usageTimeSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              {activeIntegrations.map(key => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={INTEGRATION_COLORS[key]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Sheet>
      )}

      {/* Throttled events table */}
      {recentThrottled.length > 0 && (
        <Sheet
          data-testid="rate-limit-throttled-table"
          variant="outlined"
          sx={{ p: 2, borderRadius: 'lg', bgcolor: 'admin.surface', borderColor: 'admin.border' }}
        >
          <Typography level="title-md" sx={{ mb: 2, color: 'admin.ink' }}>
            Recent throttled events (429s)
          </Typography>
          <Table size="sm" stripe="odd">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Integration</th>
                <th>Endpoint</th>
                <th>Retry After</th>
              </tr>
            </thead>
            <tbody>
              {recentThrottled.map(snap => (
                <tr key={snap._id}>
                  <td>{new Date(snap.timestamp).toLocaleString()}</td>
                  <td style={{ textTransform: 'capitalize' }}>{snap.integration}</td>
                  <td>
                    <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                      {snap.endpoint}
                    </Typography>
                  </td>
                  <td>{snap.retryAfterMs ? `${snap.retryAfterMs}ms` : '--'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Sheet>
      )}

      {/* Empty state */}
      {snapshots.length === 0 && (
        <Box data-testid="rate-limit-empty-state">
          <EmptyState
            title="No rate limit data yet"
            description="Rate limit snapshots will appear here after MCP tool calls are made."
            action={emptyAction}
          />
        </Box>
      )}
    </Stack>
  );
};
