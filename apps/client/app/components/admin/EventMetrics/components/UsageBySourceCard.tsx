import React, { useState } from 'react';
import { Box, Card, CardContent, Stack, Typography, Select, Option, Table, CircularProgress } from '@mui/joy';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import type { PieLabelRenderProps } from 'recharts';
import { useUsageBySource } from '../hooks/useUsageBySource';

// Stable colour-per-source so the chart's slice colours match the table rows
// across renders (recharts colours-by-index would re-shuffle on data changes).
const SOURCE_COLORS: Record<string, string> = {
  web: '#0088FE',
  cli: '#00C49F',
  agent: '#FFBB28',
  api: '#FF8042',
  system: '#8884D8',
};

const FALLBACK_COLOR = '#B0B0B0';

const WINDOW_OPTIONS = [
  { label: 'Last 24 hours', value: 24 },
  { label: 'Last 7 days', value: 168 },
  { label: 'Last 30 days', value: 720 },
];

/**
 * Admin widget: completion activity grouped by request surface
 * (web / cli / api / agent / system), as event counts and distinct users.
 *
 * Sources `metadata.source` on CounterLog. Buckets without a source (legacy
 * events pre-instrumentation) are excluded server-side.
 */
export const UsageBySourceCard: React.FC = () => {
  const [hours, setHours] = useState(168);
  const { data, isLoading, isError } = useUsageBySource(hours);

  const buckets = data?.buckets ?? [];
  const totalEvents = buckets.reduce((sum, b) => sum + b.events, 0);
  // Sum of per-source uniques, NOT a distinct overall user count: a user active
  // on both web and CLI is counted in each row, so the column total is
  // "activations across surfaces", not a deduplicated headcount.
  const totalSurfaceActivations = buckets.reduce((sum, b) => sum + b.uniqueUsers, 0);

  return (
    <Card data-testid="usage-by-source-card">
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography level="h4">Usage by Source</Typography>
          <Select
            value={hours}
            onChange={(_, value) => value != null && setHours(value)}
            size="sm"
            data-testid="usage-by-source-window-select"
            sx={{ minWidth: 160 }}
          >
            {WINDOW_OPTIONS.map(opt => (
              <Option key={opt.value} value={opt.value}>
                {opt.label}
              </Option>
            ))}
          </Select>
        </Stack>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size="md" />
          </Box>
        )}

        {isError && (
          <Typography level="body-sm" color="danger">
            Failed to load usage breakdown.
          </Typography>
        )}

        {!isLoading && !isError && buckets.length === 0 && (
          <Typography level="body-sm" color="neutral">
            No source-tagged events in this window yet. (Older events pre-date the source instrumentation.)
          </Typography>
        )}

        {!isLoading && !isError && buckets.length > 0 && (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center">
            <Box sx={{ width: '100%', maxWidth: 320, height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={buckets}
                    dataKey="uniqueUsers"
                    nameKey="source"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    label={entry => {
                      const { source, uniqueUsers } = entry as PieLabelRenderProps & {
                        source: string;
                        uniqueUsers: number;
                      };
                      return `${source}: ${uniqueUsers}`;
                    }}
                  >
                    {buckets.map(b => (
                      <Cell key={b.source} fill={SOURCE_COLORS[b.source] ?? FALLBACK_COLOR} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, name) => [`${value ?? 0} users`, String(name)]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </Box>

            <Box sx={{ flex: 1, width: '100%' }} data-testid="usage-by-source-table">
              <Table size="sm" stripe="odd">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th style={{ textAlign: 'right' }}>Users on Surface</th>
                    <th style={{ textAlign: 'right' }}>Events</th>
                    <th style={{ textAlign: 'right' }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map(b => (
                    <tr key={b.source}>
                      <td>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box
                            sx={{
                              width: 12,
                              height: 12,
                              borderRadius: 2,
                              bgcolor: SOURCE_COLORS[b.source] ?? FALLBACK_COLOR,
                            }}
                          />
                          <Typography level="body-sm" fontWeight="md">
                            {b.source}
                          </Typography>
                        </Stack>
                      </td>
                      <td style={{ textAlign: 'right' }}>{b.uniqueUsers.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{b.events.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        {totalEvents > 0 ? `${((b.events / totalEvents) * 100).toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <Typography level="body-sm" fontWeight="lg">
                        Total
                      </Typography>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Typography
                        level="body-sm"
                        fontWeight="lg"
                        title="Sum of users-on-surface across rows; cross-surface users are counted in each row they appear"
                      >
                        {totalSurfaceActivations.toLocaleString()}
                      </Typography>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Typography level="body-sm" fontWeight="lg">
                        {totalEvents.toLocaleString()}
                      </Typography>
                    </td>
                    <td style={{ textAlign: 'right' }}>100%</td>
                  </tr>
                </tbody>
              </Table>
            </Box>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
};
