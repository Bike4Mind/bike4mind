import React, { useState } from 'react';
import { Box, Button, Stack, Typography, Select, Option } from '@mui/joy';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { useUsageBySource } from '../hooks/useUsageBySource';
import {
  DataTable,
  EmptyState,
  FilterToolbar,
  SettingsSection,
  StatStrip,
  StatTile,
  type DataColumn,
} from '../../shared';
import { AnalyticsTermHelp } from './AnalyticsTermHelp';
import { getUsageSourceHelp } from '../utils/usageSourceHelp';
import { CHART_MUTED, adminChartSeries, chartLegendProps, chartPieProps, chartTooltipProps } from '../utils/chartTheme';

// Stable colour-per-source so the chart's slice colours match the table rows
// across renders (recharts colours-by-index would re-shuffle on data changes).
const KNOWN_SOURCES = ['web', 'cli', 'desktop', 'mcp', 'agent', 'api', 'system'] as const;
const SOURCE_COLORS: Record<string, string> = Object.fromEntries(
  adminChartSeries(KNOWN_SOURCES.length).map((color, index) => [KNOWN_SOURCES[index], color])
);

const FALLBACK_COLOR = CHART_MUTED;

const WINDOW_OPTIONS = [
  { label: 'Last 24 hours', value: 24 },
  { label: 'Last 7 days', value: 168 },
  { label: 'Last 30 days', value: 720 },
];

type SourceBucket = { source: string; events: number; uniqueUsers: number };

const sourceColor = (source: string) => SOURCE_COLORS[source] ?? FALLBACK_COLOR;

/**
 * Admin widget: completion activity grouped by request surface
 * (web / cli / desktop / mcp / api / agent / system), as event counts and distinct users.
 *
 * Sources `metadata.source` on CounterLog. Buckets without a source (legacy
 * events pre-instrumentation) are excluded server-side.
 */
export const UsageBySourceCard: React.FC = () => {
  const [hours, setHours] = useState(168);
  const { data, isLoading, isError, refetch } = useUsageBySource(hours);
  const retry = () => void refetch();

  const buckets: SourceBucket[] = data?.buckets ?? [];
  const chartBuckets = buckets.map(bucket => ({ ...bucket, label: getUsageSourceHelp(bucket.source).label }));
  const totalEvents = buckets.reduce((sum, b) => sum + b.events, 0);
  // Sum of per-source uniques, NOT a distinct overall user count: a user active
  // on both web and CLI is counted in each row, so the column total is
  // "activations across surfaces", not a deduplicated headcount.
  const totalSurfaceActivations = buckets.reduce((sum, b) => sum + b.uniqueUsers, 0);

  const columns: DataColumn<SourceBucket>[] = [
    {
      id: 'source',
      label: 'Source',
      width: '35%',
      render: b => {
        const help = getUsageSourceHelp(b.source);
        return (
          <Stack direction="row" spacing={1} alignItems="center">
            <Box
              data-testid={`usage-by-source-swatch-${b.source}`}
              sx={{ width: 12, height: 12, borderRadius: 2, flexShrink: 0, bgcolor: sourceColor(b.source) }}
            />
            <Typography level="body-sm" fontWeight="md" noWrap>
              {help.label}
            </Typography>
            <AnalyticsTermHelp term={help.label} description={`${help.description} Recorded value: ${b.source}.`} />
          </Stack>
        );
      },
    },
    {
      id: 'users',
      label: 'Users',
      numeric: true,
      help: (
        <AnalyticsTermHelp
          term="Users"
          description="Distinct users with activity in this source during the selected period. A person using multiple sources is counted once in each row. The chart shows these counts."
        />
      ),
      render: b => b.uniqueUsers.toLocaleString(),
    },
    {
      id: 'events',
      label: 'Events',
      numeric: true,
      help: (
        <AnalyticsTermHelp
          term="Events"
          description="Recorded actions for this source during the selected period. One person can generate many events. Background activity can have events without an associated user."
        />
      ),
      render: b => b.events.toLocaleString(),
    },
    {
      id: 'share',
      label: 'Event share',
      numeric: true,
      help: (
        <AnalyticsTermHelp
          term="Event share"
          description="This source's events divided by all events shown in this table. This percentage measures events; the chart shows users per source."
        />
      ),
      render: b => (totalEvents > 0 ? `${((b.events / totalEvents) * 100).toFixed(1)}%` : '-'),
    },
  ];

  return (
    <SettingsSection data-testid="usage-by-source-card" sx={{ mb: 0 }}>
      <Stack direction="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1 }}>
        <Stack direction="row" alignItems="center">
          <Typography level="title-md" component="h3" sx={{ color: 'admin.ink' }}>
            Usage by source
          </Typography>
          <Box sx={{ display: 'flex', '& svg': { fontSize: 16 } }}>
            <AnalyticsTermHelp
              term="Usage by source"
              description="Groups recorded activity by its source. Sources can be apps, entry points, or automatic/manual triggers, so this is not a comparison of apps alone. Events without a source are excluded."
            />
          </Box>
        </Stack>
        <FilterToolbar data-testid="usage-by-source-toolbar">
          <Select
            value={hours}
            onChange={(_, value) => value != null && setHours(value)}
            size="sm"
            aria-label="Time window"
            data-testid="usage-by-source-window-select"
            sx={{ minWidth: 160 }}
          >
            {WINDOW_OPTIONS.map(opt => (
              <Option key={opt.value} value={opt.value}>
                {opt.label}
              </Option>
            ))}
          </Select>
        </FilterToolbar>
      </Stack>

      <Typography level="body-sm" sx={{ mb: 2, color: 'admin.inkMuted' }}>
        Sources include apps, entry points, and triggers. Hover, focus, or tap a help icon for an explanation.
      </Typography>

      {buckets.length > 0 && !isError && (
        <Box sx={{ mb: 2 }}>
          <StatStrip aria-label="Usage totals">
            <StatTile label="Total events" value={totalEvents.toLocaleString()} />
            <StatTile
              label="Total users"
              value={totalSurfaceActivations.toLocaleString()}
              help={
                <AnalyticsTermHelp
                  term="Total users"
                  description="Sum of the user counts in each row, not a count of distinct people across all sources. Someone active in two sources contributes two to this total."
                />
              }
            />
          </StatStrip>
        </Box>
      )}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center">
        {buckets.length > 0 && !isError && (
          <Box sx={{ width: '100%', maxWidth: 320, height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartBuckets}
                  dataKey="uniqueUsers"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  {...chartPieProps}
                >
                  {buckets.map(b => (
                    <Cell key={b.source} fill={sourceColor(b.source)} />
                  ))}
                </Pie>
                <Tooltip {...chartTooltipProps} formatter={(value, name) => [`${value ?? 0} users`, String(name)]} />
                <Legend {...chartLegendProps} />
              </PieChart>
            </ResponsiveContainer>
          </Box>
        )}

        <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          {/* Below 28rem the table scrolls sideways instead of crushing its four columns. */}
          <DataTable
            label="Usage by source"
            testId="usage-by-source-table"
            framed={false}
            minWidth="28rem"
            pagination={false}
            rows={buckets}
            columns={columns}
            getRowId={b => b.source}
            rowTestId={b => `usage-by-source-row-${b.source}`}
            loading={isLoading}
            error={isError ? 'Failed to load usage breakdown.' : undefined}
            onRetry={retry}
            empty={
              <EmptyState
                title="No source-tagged events in this window yet"
                description="Older events pre-date the source instrumentation."
                action={
                  <Button variant="outlined" onClick={retry} data-testid="usage-by-source-refresh-btn">
                    Refresh
                  </Button>
                }
              />
            }
          />
        </Box>
      </Stack>
    </SettingsSection>
  );
};
