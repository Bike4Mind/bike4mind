import React, { useMemo } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, LinearProgress, Sheet, Stack, Table, Typography } from '@mui/joy';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

// Hardcoded chart colors - Recharts renders via SVG and cannot resolve CSS variables
const CHART_COLORS = {
  primary: '#1976d2',
  warning: '#ed6c02',
  danger: '#d32f2f',
};
import { useIntegrationHistory } from '../hooks/useIntegrationHistory';
import { buildLatencyTimeSeries, buildErrorRateSeries } from '../utils/chartDataProcessor';
import type { IntegrationDashboardEntry, CircuitBreakerMode, IntegrationName, InMemoryBreakerState } from '../types';

interface IntegrationDetailPanelProps {
  entry: IntegrationDashboardEntry;
  isExpanded: boolean;
  inMemoryBreakers: Record<string, InMemoryBreakerState>;
  onOverride: (integration: IntegrationName, mode: CircuitBreakerMode, reason?: string) => void;
  isUpdatingOverride: boolean;
}

function statusColor(status: string): 'success' | 'warning' | 'danger' {
  if (status === 'healthy' || status === 'CLOSED') return 'success';
  if (status === 'degraded' || status === 'HALF_OPEN') return 'warning';
  return 'danger';
}

function rateLimitColor(usagePercent: number | null): 'success' | 'warning' | 'danger' {
  if (usagePercent === null) return 'success';
  if (usagePercent >= 90) return 'danger';
  if (usagePercent >= 70) return 'warning';
  return 'success';
}

export const IntegrationDetailPanel: React.FC<IntegrationDetailPanelProps> = ({
  entry,
  isExpanded,
  inMemoryBreakers,
  onOverride,
  isUpdatingOverride,
}) => {
  const {
    checks,
    isLoading: historyLoading,
    isError: historyError,
  } = useIntegrationHistory(isExpanded ? entry.name : null, isExpanded);

  const latencyData = useMemo(() => buildLatencyTimeSeries(checks), [checks]);
  const errorRateData = useMemo(() => buildErrorRateSeries(checks), [checks]);

  // Find in-memory breaker states for this integration
  const readBreaker = inMemoryBreakers[`${entry.name}:read`];
  const writeBreaker = inMemoryBreakers[`${entry.name}:write`];

  return (
    <Box sx={{ pt: 2 }}>
      <Stack spacing={3}>
        {/* Latency Chart */}
        <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }} data-testid={`latency-chart-${entry.name}`}>
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Latency (P50 / P95)
          </Typography>
          {historyError ? (
            <Alert color="danger" variant="soft" size="sm">
              Failed to load history data
            </Alert>
          ) : historyLoading ? (
            <LinearProgress />
          ) : latencyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={latencyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--joy-palette-divider, #e0e0e0)" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit="ms" />
                <Tooltip />
                <Legend />
                <ReferenceLine y={2000} stroke={CHART_COLORS.warning} strokeDasharray="4 4" label="Warning" />
                <ReferenceLine y={5000} stroke={CHART_COLORS.danger} strokeDasharray="4 4" label="Critical" />
                <Line
                  type="monotone"
                  dataKey="p50"
                  stroke={CHART_COLORS.primary}
                  strokeWidth={2}
                  dot={false}
                  name="P50"
                />
                <Line
                  type="monotone"
                  dataKey="p95"
                  stroke={CHART_COLORS.warning}
                  strokeWidth={2}
                  dot={false}
                  strokeDasharray="5 5"
                  name="P95"
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <Typography level="body-sm" color="neutral" sx={{ py: 4, textAlign: 'center' }}>
              No latency data available for this time range
            </Typography>
          )}
        </Sheet>

        {/* Error Rate Chart */}
        <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }}>
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Error Rate
          </Typography>
          {historyError ? (
            <Alert color="danger" variant="soft" size="sm">
              Failed to load error rate data
            </Alert>
          ) : historyLoading ? (
            <LinearProgress />
          ) : errorRateData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={errorRateData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--joy-palette-divider, #e0e0e0)" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="failures" fill={CHART_COLORS.danger} name="Failures" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Typography level="body-sm" color="neutral" sx={{ py: 4, textAlign: 'center' }}>
              No error data available for this time range
            </Typography>
          )}
        </Sheet>

        {/* Rate Limit Usage */}
        {entry.rateLimit && (
          <Card variant="outlined">
            <CardContent>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Rate Limit Usage
              </Typography>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box sx={{ flex: 1 }}>
                  <LinearProgress
                    determinate
                    value={entry.rateLimit.usagePercent ?? 0}
                    color={rateLimitColor(entry.rateLimit.usagePercent)}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                </Box>
                <Typography level="body-sm">
                  {entry.rateLimit.remaining ?? '--'} / {entry.rateLimit.limit ?? '--'}
                </Typography>
                {entry.rateLimit.usagePercent != null && (
                  <Chip size="sm" variant="soft" color={rateLimitColor(entry.rateLimit.usagePercent)}>
                    {entry.rateLimit.usagePercent}%
                  </Chip>
                )}
                {entry.rateLimit.wasThrottled && (
                  <Chip size="sm" color="danger" variant="soft">
                    Throttled
                  </Chip>
                )}
              </Stack>
              {entry.rateLimit.resetAt && (
                <Typography level="body-xs" color="neutral" sx={{ mt: 0.5 }}>
                  Resets at {new Date(entry.rateLimit.resetAt).toLocaleTimeString()}
                </Typography>
              )}
            </CardContent>
          </Card>
        )}

        {/* Circuit Breaker Controls */}
        <Card variant="outlined" data-testid={`circuit-breaker-override-${entry.name}`}>
          <CardContent>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Circuit Breaker
            </Typography>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Typography level="body-sm">DB-backed override:</Typography>
                <Chip
                  size="sm"
                  variant="soft"
                  color={statusColor(entry.circuitBreaker.available ? 'healthy' : 'unhealthy')}
                >
                  {entry.circuitBreaker.mode}
                </Chip>
                {entry.circuitBreaker.autoTripped && (
                  <Chip size="sm" color="danger" variant="soft">
                    Auto-tripped
                  </Chip>
                )}
                {entry.circuitBreaker.reason && (
                  <Typography level="body-xs" color="neutral">
                    {entry.circuitBreaker.reason}
                  </Typography>
                )}
              </Stack>

              <Stack direction="row" spacing={0.5}>
                {(['auto', 'force_open', 'force_block'] as const).map(mode => (
                  <Button
                    key={mode}
                    size="sm"
                    variant={entry.circuitBreaker.mode === mode ? 'solid' : 'outlined'}
                    color={mode === 'force_block' ? 'danger' : mode === 'force_open' ? 'success' : 'neutral'}
                    onClick={() => onOverride(entry.name, mode)}
                    loading={isUpdatingOverride}
                    data-testid={`circuit-breaker-${mode}-btn-${entry.name}`}
                  >
                    {mode === 'auto' ? 'Auto' : mode === 'force_open' ? 'Force Open' : 'Force Block'}
                  </Button>
                ))}
              </Stack>

              {/* In-memory breaker states (per-operation CircuitBreaker snapshots) */}
              {(readBreaker || writeBreaker) && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography level="body-xs" color="neutral">
                    In-memory MCP:
                  </Typography>
                  {readBreaker && (
                    <Chip size="sm" variant="soft" color={statusColor(readBreaker.state)}>
                      Read: {readBreaker.state}
                    </Chip>
                  )}
                  {writeBreaker && (
                    <Chip size="sm" variant="soft" color={statusColor(writeBreaker.state)}>
                      Write: {writeBreaker.state}
                    </Chip>
                  )}
                </Stack>
              )}
            </Stack>
          </CardContent>
        </Card>

        {/* Recent Errors Table */}
        {entry.recentErrors.length > 0 && (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm' }}>
            <Typography level="title-sm" sx={{ p: 2, pb: 1 }}>
              Recent Errors ({entry.recentErrors.length})
            </Typography>
            <Table size="sm" stripe="odd" sx={{ '& th': { py: 1 }, '& td': { py: 0.5 } }}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Source</th>
                  <th>Message</th>
                  <th>Code</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {entry.recentErrors.map((err, idx) => (
                  <tr key={idx}>
                    <td>
                      <Typography level="body-xs">{new Date(err.occurredAt).toLocaleString()}</Typography>
                    </td>
                    <td>
                      <Chip size="sm" variant="soft" color={err.source === 'health_check' ? 'primary' : 'neutral'}>
                        {err.source === 'health_check' ? 'Probe' : 'Audit'}
                      </Chip>
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {err.message}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                        {err.errorCode || '--'}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs">{err.action || '--'}</Typography>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Sheet>
        )}

        {entry.recentErrors.length === 0 && (
          <Typography level="body-sm" color="neutral" sx={{ textAlign: 'center', py: 2 }}>
            No recent errors
          </Typography>
        )}
      </Stack>
    </Box>
  );
};
