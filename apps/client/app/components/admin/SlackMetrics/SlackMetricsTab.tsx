import React, { type ReactNode } from 'react';
import { Box } from '@mui/joy';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import type { ChartData } from '../EventMetrics/utils/chartDataProcessor';
import {
  CHART_ACCENT,
  CHART_BAD,
  CHART_GOOD,
  adminChartSeries,
  chartAxisProps,
  chartGridProps,
  chartLegendProps,
  chartPieProps,
  chartTooltipProps,
} from '../EventMetrics/utils/chartTheme';
import { ChartDataTable, ChartSection, EmptyState, type ChartSectionBody } from '../shared';

interface SlackMetricsTabProps {
  chartData: ChartData;
  /** The page's range or filters are set, so an empty view may be down to them. */
  filtered: boolean;
  /** The empty state's next step: Clear filters when `filtered`, else a refresh. */
  emptyAction: ReactNode;
}

type Slice = { name: string; value: number };

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const sumOf = (rows: readonly Slice[]) => rows.reduce((sum, row) => sum + row.value, 0);
const largest = (rows: readonly Slice[]) =>
  rows.reduce<Slice | undefined>((best, row) => (!best || row.value > best.value ? row : best), undefined);

/** A chart body for one name/value series: a notice when the series is empty, else the chart and its table. */
function sliceBody({
  rows,
  emptyTitle,
  caption,
  chart,
  tableLabel,
  testId,
  valueLabel = 'Count',
}: {
  rows: readonly Slice[];
  emptyTitle: string;
  caption: (rows: readonly Slice[]) => string;
  chart: ReactNode;
  tableLabel: string;
  testId: string;
  valueLabel?: string;
}): ChartSectionBody {
  if (rows.length === 0) return { kind: 'notice', content: <EmptyState title={emptyTitle} action={null} /> };
  return {
    kind: 'ready',
    caption: caption(rows),
    chart,
    table: (
      <ChartDataTable
        label={tableLabel}
        testId={`${testId}-table`}
        rows={rows}
        getRowId={row => row.name}
        columns={[
          { id: 'name', label: 'Name', render: row => row.name },
          { id: 'value', label: valueLabel, numeric: true, render: row => row.value.toLocaleString() },
        ]}
      />
    ),
  };
}

const mostCommon = (noun: string) => (rows: readonly Slice[]) => {
  const top = largest(rows);
  return top
    ? `${top.name} is the most common ${noun} (${top.value.toLocaleString()} of ${sumOf(rows).toLocaleString()})`
    : '';
};

export const SlackMetricsTab: React.FC<SlackMetricsTabProps> = ({ chartData, filtered, emptyAction }) => {
  const { slackMetrics } = chartData;

  const typeData = React.useMemo(
    () => (slackMetrics ? Object.entries(slackMetrics.eventsByType).map(([name, value]) => ({ name, value })) : []),
    [slackMetrics]
  );

  const formatData = React.useMemo(
    () =>
      slackMetrics
        ? Object.entries(slackMetrics.exportFormats)
            .map(([name, value]) => ({ name, value }))
            .filter(d => d.value > 0)
        : [],
    [slackMetrics]
  );

  const statusData = React.useMemo(
    () =>
      slackMetrics
        ? [
            { name: 'Success', value: slackMetrics.exportStatus.success },
            { name: 'Failed', value: slackMetrics.exportStatus.failed },
          ].filter(d => d.value > 0)
        : [],
    [slackMetrics]
  );

  const agentData = React.useMemo(
    () =>
      slackMetrics ? Object.entries(slackMetrics.agentDistribution).map(([name, value]) => ({ name, value })) : [],
    [slackMetrics]
  );

  const intentData = React.useMemo(
    () =>
      slackMetrics ? Object.entries(slackMetrics.intentDistribution).map(([name, value]) => ({ name, value })) : [],
    [slackMetrics]
  );

  if (!slackMetrics) {
    return filtered ? (
      <EmptyState title="No events match these filters" action={emptyAction} />
    ) : (
      <EmptyState
        title="No Slack events yet"
        description="Slack integration events appear here once tracked."
        action={emptyAction}
      />
    );
  }

  const agentColors = adminChartSeries(agentData.length);
  const intentColors = adminChartSeries(intentData.length);
  const formatColors = adminChartSeries(formatData.length);

  const success = slackMetrics.exportStatus.success;
  const exportsTotal = success + slackMetrics.exportStatus.failed;

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' },
        '& > .slack-wide': { gridColumn: { xs: 'auto', md: '1 / -1', lg: 'span 2' } },
      }}
    >
      <Box className="slack-wide" sx={{ minWidth: 0 }}>
        <ChartSection
          title="Slack event activity"
          testId="slack-activity"
          body={sliceBody({
            rows: typeData,
            emptyTitle: 'No Slack events recorded',
            caption: rows => `${plural(sumOf(rows), 'event')} across ${plural(rows.length, 'event type')}`,
            tableLabel: 'Slack events by type',
            testId: 'slack-activity',
            valueLabel: 'Events',
            chart: (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={typeData} layout="vertical">
                  <CartesianGrid {...chartGridProps} />
                  <XAxis type="number" {...chartAxisProps} />
                  <YAxis dataKey="name" type="category" width={180} {...chartAxisProps} />
                  <Tooltip {...chartTooltipProps} />
                  <Bar dataKey="value" fill={CHART_ACCENT} name="Count" />
                </BarChart>
              </ResponsiveContainer>
            ),
          })}
        />
      </Box>

      <ChartSection
        title="Agent usage"
        testId="slack-agents"
        body={sliceBody({
          rows: agentData,
          emptyTitle: 'No agent usage recorded',
          caption: mostCommon('agent'),
          tableLabel: 'Agent usage',
          testId: 'slack-agents',
          chart: (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={agentData}
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  {...chartPieProps}
                >
                  {agentData.map((entry, index) => (
                    <Cell key={`agent-${entry.name}`} fill={agentColors[index]} />
                  ))}
                </Pie>
                <Tooltip {...chartTooltipProps} />
                <Legend {...chartLegendProps} />
              </PieChart>
            </ResponsiveContainer>
          ),
        })}
      />

      <ChartSection
        title="Intent breakdown"
        testId="slack-intents"
        body={sliceBody({
          rows: intentData,
          emptyTitle: 'No intents recorded',
          caption: mostCommon('intent'),
          tableLabel: 'Intent breakdown',
          testId: 'slack-intents',
          chart: (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={intentData}
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  {...chartPieProps}
                >
                  {intentData.map((entry, index) => (
                    <Cell key={`intent-${entry.name}`} fill={intentColors[index]} />
                  ))}
                </Pie>
                <Tooltip {...chartTooltipProps} />
                <Legend {...chartLegendProps} />
              </PieChart>
            </ResponsiveContainer>
          ),
        })}
      />

      <ChartSection
        title="Export formats"
        testId="slack-export-formats"
        body={sliceBody({
          rows: formatData,
          emptyTitle: 'No exports recorded',
          caption: mostCommon('format'),
          tableLabel: 'Export formats',
          testId: 'slack-export-formats',
          chart: (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={formatData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  {...chartPieProps}
                >
                  {formatData.map((entry, index) => (
                    <Cell key={`format-${entry.name}`} fill={formatColors[index]} />
                  ))}
                </Pie>
                <Tooltip {...chartTooltipProps} />
                <Legend {...chartLegendProps} />
              </PieChart>
            </ResponsiveContainer>
          ),
        })}
      />

      <ChartSection
        title="Export success rate"
        testId="slack-export-success"
        body={sliceBody({
          rows: statusData,
          emptyTitle: 'No exports recorded',
          caption: () =>
            `${Math.round((success / exportsTotal) * 100)}% of ${exportsTotal.toLocaleString()} exports succeeded`,
          tableLabel: 'Export outcomes',
          testId: 'slack-export-success',
          valueLabel: 'Exports',
          chart: (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={statusData} cx="50%" cy="50%" outerRadius={80} dataKey="value" {...chartPieProps}>
                  {/* Keyed by name: a zero count is filtered out, so position does not tell the status. */}
                  {statusData.map(entry => (
                    <Cell key={`status-${entry.name}`} fill={entry.name === 'Success' ? CHART_GOOD : CHART_BAD} />
                  ))}
                </Pie>
                <Tooltip {...chartTooltipProps} />
                <Legend {...chartLegendProps} />
              </PieChart>
            </ResponsiveContainer>
          ),
        })}
      />
    </Box>
  );
};
