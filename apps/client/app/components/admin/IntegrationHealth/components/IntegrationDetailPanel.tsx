import React, { useMemo } from 'react';
import { Box, Button, Chip, Divider, Stack, Table, Typography } from '@mui/joy';
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
import { ErrorState, InlineBar, LoadingState, StatusChip } from '@client/app/components/admin/shared';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ACCENT,
  BAD,
  BORDER,
  COMPARISON_OPACITY,
  INK_MUTED,
  WARN,
  xAxisProps,
  yAxisProps,
} from '@client/app/components/admin/shared/chartParts';
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

const BREAKER_TONE: Record<InMemoryBreakerState['state'], AdminStatusTone> = {
  CLOSED: 'good',
  HALF_OPEN: 'warn',
  OPEN: 'bad',
};

const MODE_LABEL: Record<CircuitBreakerMode, string> = {
  auto: 'Auto (all users)',
  force_open: 'Force open',
  force_block: 'Force block',
};

function rateLimitTone(usagePercent: number): AdminStatusTone {
  if (usagePercent >= 90) return 'bad';
  if (usagePercent >= 70) return 'warn';
  return 'good';
}

/** A subsection of the expanded row: a section heading, then its body. No box of its own. */
function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <Stack gap={1} data-testid={testId}>
      <Typography level="title-sm" component="h3" sx={{ color: 'admin.ink' }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

function MutedNote({ children }: { children: React.ReactNode }) {
  return (
    <Typography level="body-sm" sx={{ color: 'admin.inkMuted', py: 2 }}>
      {children}
    </Typography>
  );
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
    refetch: refetchHistory,
    isRefetching: historyRefetching,
  } = useIntegrationHistory(isExpanded ? entry.name : null, isExpanded);

  const latencyData = useMemo(() => buildLatencyTimeSeries(checks), [checks]);
  const errorRateData = useMemo(() => buildErrorRateSeries(checks), [checks]);

  const readBreaker = inMemoryBreakers[`${entry.name}:read`];
  const writeBreaker = inMemoryBreakers[`${entry.name}:write`];

  const historyState = historyError ? (
    <ErrorState
      message="Probe history failed to load."
      onRetry={() => void refetchHistory()}
      retrying={historyRefetching}
    />
  ) : historyLoading ? (
    <LoadingState label="Loading probe history" />
  ) : null;

  return (
    <Stack gap={2} divider={<Divider />} sx={{ pt: 2 }}>
      <Section title="Latency (p50 and p95)" testId={`latency-chart-${entry.name}`}>
        {historyState ??
          (latencyData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={latencyData}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} vertical={false} />
                <XAxis dataKey="time" {...xAxisProps} />
                <YAxis {...yAxisProps} unit="ms" />
                <Tooltip />
                <Legend />
                <ReferenceLine y={2000} stroke={WARN} strokeDasharray="4 4" label="Warning" />
                <ReferenceLine y={5000} stroke={BAD} strokeDasharray="4 4" label="Critical" />
                <Line type="monotone" dataKey="p50" stroke={ACCENT} strokeWidth={2} dot={false} name="P50" />
                <Line
                  type="monotone"
                  dataKey="p95"
                  stroke={INK_MUTED}
                  strokeOpacity={COMPARISON_OPACITY}
                  strokeWidth={2}
                  dot={false}
                  strokeDasharray="5 5"
                  name="P95"
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <MutedNote>No latency data for this time range.</MutedNote>
          ))}
      </Section>

      <Section title="Error rate">
        {historyState ??
          (errorRateData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={errorRateData}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} vertical={false} />
                <XAxis dataKey="time" {...xAxisProps} />
                <YAxis {...yAxisProps} allowDecimals={false} />
                <Tooltip cursor={{ fill: 'var(--joy-palette-admin-hover)' }} />
                <Bar dataKey="failures" fill={BAD} name="Failures" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <MutedNote>No errors in this time range.</MutedNote>
          ))}
      </Section>

      {entry.rateLimit && (
        <Section title="Rate limit usage">
          <Stack direction="row" alignItems="center" gap={2} flexWrap="wrap">
            <InlineBar value={entry.rateLimit.usagePercent ?? 0} max={100} />
            <Typography level="body-sm" sx={{ color: 'admin.ink', fontVariantNumeric: 'tabular-nums' }}>
              {entry.rateLimit.remaining?.toLocaleString() ?? '-'} / {entry.rateLimit.limit?.toLocaleString() ?? '-'}{' '}
              remaining
            </Typography>
            {entry.rateLimit.usagePercent != null && (
              <StatusChip
                tone={rateLimitTone(entry.rateLimit.usagePercent)}
                label={`${entry.rateLimit.usagePercent}% used`}
              />
            )}
            {entry.rateLimit.wasThrottled && <StatusChip tone="bad" label="Throttled" />}
          </Stack>
          {entry.rateLimit.resetAt && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              Resets at {new Date(entry.rateLimit.resetAt).toLocaleTimeString()}
            </Typography>
          )}
        </Section>
      )}

      <Section title="Circuit breaker" testId={`circuit-breaker-override-${entry.name}`}>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
            Override:
          </Typography>
          <StatusChip
            tone={entry.circuitBreaker.available ? 'good' : 'bad'}
            label={MODE_LABEL[entry.circuitBreaker.mode]}
          />
          {entry.circuitBreaker.autoTripped && <StatusChip tone="bad" label="Auto-tripped" />}
          {entry.circuitBreaker.reason && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {entry.circuitBreaker.reason}
            </Typography>
          )}
        </Stack>

        <Stack direction="row" gap={1} flexWrap="wrap">
          {(['auto', 'force_open', 'force_block'] as const).map(mode => {
            const selected = entry.circuitBreaker.mode === mode;
            return (
              <Button
                key={mode}
                size="sm"
                variant={selected ? 'solid' : 'outlined'}
                // Force block cuts the integration off for every user, so it reads as destructive until it is the active mode.
                color={mode === 'force_block' && !selected ? 'danger' : 'neutral'}
                onClick={() => onOverride(entry.name, mode)}
                loading={isUpdatingOverride}
                title={mode === 'auto' ? 'Also resets the in-memory MCP breakers for all users' : undefined}
                data-testid={`circuit-breaker-${mode}-btn-${entry.name}`}
              >
                {MODE_LABEL[mode]}
              </Button>
            );
          })}
        </Stack>

        {(readBreaker || writeBreaker) && (
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Typography
              level="body-xs"
              sx={{ color: 'admin.inkMuted' }}
              title="Worst state across users: OPEN means open for at least one user"
            >
              In-memory MCP (worst across users):
            </Typography>
            {readBreaker && <StatusChip tone={BREAKER_TONE[readBreaker.state]} label={`Read: ${readBreaker.state}`} />}
            {writeBreaker && (
              <StatusChip tone={BREAKER_TONE[writeBreaker.state]} label={`Write: ${writeBreaker.state}`} />
            )}
          </Stack>
        )}
      </Section>

      <Section title={`Recent errors (${entry.recentErrors.length})`}>
        {entry.recentErrors.length > 0 ? (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="sm" sx={{ minWidth: 560, '& th': { py: 1 }, '& td': { py: 0.5 } }}>
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
                      <Chip size="sm" variant="soft" color="neutral">
                        {err.source === 'health_check' ? 'Probe' : 'Audit'}
                      </Chip>
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {err.message}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'admin.inkMuted' }}>
                        {err.errorCode || '-'}
                      </Typography>
                    </td>
                    <td>
                      <Typography level="body-xs">{err.action || '-'}</Typography>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Box>
        ) : (
          <MutedNote>No recent errors.</MutedNote>
        )}
      </Section>
    </Stack>
  );
};
