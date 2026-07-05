import React from 'react';
import { Box, Card, CardContent, Chip, Grid, Sheet, Stack, Table, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { RATE_LIMIT_INTEGRATIONS } from '@bike4mind/common';
import type { ChartData, RateLimitSnapshot } from '../types';

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
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ chartData, snapshots }) => {
  const theme = useTheme();

  const recentThrottled = snapshots.filter(s => s.wasThrottled).slice(0, 20);

  // Only render chart lines for integrations that have data points
  const activeIntegrations = RATE_LIMIT_INTEGRATIONS.filter(key =>
    chartData.usageTimeSeries.some(point => (point[key] as number) > 0)
  );

  return (
    <Box>
      {/* Integration summary cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {chartData.integrationSummaries.map(summary => (
          <Grid key={summary.integration} xs={12} sm={6} md={3}>
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                  <Typography level="title-sm" sx={{ textTransform: 'capitalize' }}>
                    {summary.integration}
                  </Typography>
                  <Stack direction="row" spacing={0.5}>
                    {summary.avgUsagePercent >= 80 && (
                      <Chip size="sm" color="warning" variant="soft">
                        Near Limit
                      </Chip>
                    )}
                    {summary.throttledCount > 0 && (
                      <Chip size="sm" color="danger" variant="soft">
                        Throttled
                      </Chip>
                    )}
                  </Stack>
                </Stack>
                <Typography level="h3">
                  {summary.latestRemaining !== null ? summary.latestRemaining : '--'}
                  <Typography level="body-sm" component="span">
                    {summary.latestLimit !== null ? ` / ${summary.latestLimit}` : ''}
                  </Typography>
                </Typography>
                <Typography level="body-xs" color={summary.avgUsagePercent > 80 ? 'warning' : 'neutral'}>
                  {summary.avgUsagePercent}% avg usage | {summary.throttledCount} throttled
                </Typography>
                {summary.latestResetAt && new Date(summary.latestResetAt) > new Date() && (
                  <Typography level="body-xs" color="primary">
                    {formatResetTime(summary.latestResetAt)}
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Usage over time chart */}
      {chartData.usageTimeSeries.length > 0 && (
        <Sheet data-testid="rate-limit-chart-container" variant="outlined" sx={{ p: 2, mb: 3, borderRadius: 'sm' }}>
          <Typography level="title-md" sx={{ mb: 2 }}>
            Usage % Over Time
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
        <Sheet data-testid="rate-limit-throttled-table" variant="outlined" sx={{ p: 2, borderRadius: 'sm' }}>
          <Typography level="title-md" sx={{ mb: 2 }}>
            Recent Throttled Events (429s)
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
        <Box data-testid="rate-limit-empty-state" sx={{ textAlign: 'center', py: 6 }}>
          <Typography level="h4" color="neutral">
            No rate limit data yet
          </Typography>
          <Typography level="body-sm" color="neutral">
            Rate limit snapshots will appear here after MCP tool calls are made.
          </Typography>
        </Box>
      )}
    </Box>
  );
};
