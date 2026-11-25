import React from 'react';
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
  LineChart,
  Line,
} from 'recharts';
import type { PieLabelRenderProps } from 'recharts';
import type { ChartData } from '../utils/chartDataProcessor';
import { UsageBySourceCard } from './UsageBySourceCard';
import { AnalyticsTermHelp } from './AnalyticsTermHelp';
import { ChartDataTable, ChartSection, EmptyState } from '../../shared';
import {
  CHART_ACCENT,
  CHART_LABEL_FILL,
  adminChartSeries,
  chartAxisProps,
  chartGridProps,
  chartLegendProps,
  chartLineDotProps,
  chartPieProps,
  chartTooltipProps,
} from '../utils/chartTheme';

interface OverviewTabProps {
  chartData: Pick<ChartData, 'timeSeriesData' | 'categoryBreakdown' | 'topEvents'>;
  showUsageBySource?: boolean;
  isCompleteWindow?: boolean;
}

const noEvents = { kind: 'notice', content: <EmptyState title="No events in this report" action={null} /> } as const;

export const OverviewTab: React.FC<OverviewTabProps> = ({
  chartData,
  showUsageBySource = true,
  isCompleteWindow = false,
}) => {
  const { timeSeriesData, categoryBreakdown, topEvents } = chartData;
  const categoryColors = adminChartSeries(categoryBreakdown.length);
  const top10 = topEvents.slice(0, 10);
  const totalEvents = timeSeriesData.reduce((sum, point) => sum + point.count, 0);
  const topCategory = categoryBreakdown.reduce<(typeof categoryBreakdown)[number] | undefined>(
    (best, entry) => (!best || entry.count > best.count ? entry : best),
    undefined
  );
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
        '& > .overview-wide': { gridColumn: '1 / -1' },
      }}
    >
      {/* Usage by source has its own admin endpoint, so it loads regardless of this tab's filters. */}
      {showUsageBySource && (
        <Box className="overview-wide" sx={{ minWidth: 0 }}>
          <UsageBySourceCard />
        </Box>
      )}

      <Box className="overview-wide" sx={{ minWidth: 0 }}>
        <ChartSection
          title="Events over time"
          testId="overview-events-over-time"
          help={
            <AnalyticsTermHelp
              term="Events over time"
              description={
                isCompleteWindow
                  ? 'Number of recorded events on each UTC date across the complete seven-day window. Every date is included, with zero for days without activity. Each event counts once, even if the same person acts repeatedly. Today is still in progress.'
                  : "Number of loaded events recorded on each date, using your browser's time zone. Each event counts once, even if the same person acts repeatedly. Dates with no loaded events are omitted. These counts reflect the loaded snapshot, not necessarily all activity in that period."
              }
            />
          }
          body={
            timeSeriesData.length === 0
              ? noEvents
              : {
                  kind: 'ready',
                  caption: `${plural(totalEvents, 'event')} across ${plural(timeSeriesData.length, isCompleteWindow ? 'day' : 'active day')}`,
                  chart: (
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={timeSeriesData}>
                        <CartesianGrid {...chartGridProps} />
                        <XAxis dataKey="date" {...chartAxisProps} />
                        <YAxis {...chartAxisProps} />
                        <Tooltip {...chartTooltipProps} />
                        <Legend {...chartLegendProps} />
                        <Line
                          type="monotone"
                          dataKey="count"
                          stroke={CHART_ACCENT}
                          name="Event Count"
                          {...chartLineDotProps}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ),
                  table: (
                    <ChartDataTable
                      label="Events per date"
                      testId="overview-events-over-time-table"
                      rows={timeSeriesData}
                      getRowId={row => row.date}
                      columns={[
                        { id: 'date', label: 'Date', render: row => row.date },
                        { id: 'count', label: 'Events', numeric: true, render: row => row.count.toLocaleString() },
                      ]}
                    />
                  ),
                }
          }
        />
      </Box>

      <ChartSection
        title="Events by category"
        testId="overview-events-by-category"
        help={
          <AnalyticsTermHelp
            term="Events by category"
            description="Groups the events in this report by keywords in their names, such as Session, File or Auth. Each slice counts recorded events, not distinct users. Events whose names match none of these groups appear as Other."
          />
        }
        body={
          !topCategory
            ? noEvents
            : {
                kind: 'ready',
                caption: `${topCategory.category} is the largest category with ${plural(topCategory.count, 'event')}`,
                chart: (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={categoryBreakdown}
                        dataKey="count"
                        nameKey="category"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        {...chartPieProps}
                        label={entry => {
                          const { category, count, x, y, textAnchor } = entry as PieLabelRenderProps & {
                            category: string;
                            count: number;
                          };
                          return (
                            <text
                              x={x}
                              y={y}
                              textAnchor={textAnchor}
                              dominantBaseline="central"
                              fill={CHART_LABEL_FILL}
                              fontSize={12}
                            >
                              {`${category}: ${count}`}
                            </text>
                          );
                        }}
                      >
                        {categoryBreakdown.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={categoryColors[index]} />
                        ))}
                      </Pie>
                      <Tooltip {...chartTooltipProps} />
                      <Legend {...chartLegendProps} />
                    </PieChart>
                  </ResponsiveContainer>
                ),
                table: (
                  <ChartDataTable
                    label="Events by category"
                    testId="overview-events-by-category-table"
                    rows={categoryBreakdown}
                    getRowId={row => row.category}
                    columns={[
                      { id: 'category', label: 'Category', render: row => row.category },
                      { id: 'count', label: 'Events', numeric: true, render: row => row.count.toLocaleString() },
                    ]}
                  />
                ),
              }
        }
      />

      <ChartSection
        title="Top 10 events"
        testId="overview-top-events"
        help={
          <AnalyticsTermHelp
            term="Top 10 events"
            description="The ten most frequently recorded event names in this report. Each occurrence counts once. A feature can record several kinds of events, and one person can generate many events, so this is not a ranking of features by number of users."
          />
        }
        body={
          top10.length === 0
            ? noEvents
            : {
                kind: 'ready',
                caption: `${top10[0].eventName} is the most recorded event (${top10[0].count.toLocaleString()})`,
                chart: (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={top10}>
                      <CartesianGrid {...chartGridProps} />
                      <XAxis dataKey="eventName" angle={-45} textAnchor="end" height={120} {...chartAxisProps} />
                      <YAxis {...chartAxisProps} />
                      <Tooltip {...chartTooltipProps} />
                      <Legend {...chartLegendProps} />
                      <Bar dataKey="count" fill={CHART_ACCENT} name="Count" />
                    </BarChart>
                  </ResponsiveContainer>
                ),
                table: (
                  <ChartDataTable
                    label="Top 10 events"
                    testId="overview-top-events-table"
                    rows={top10}
                    getRowId={row => row.eventName}
                    columns={[
                      { id: 'eventName', label: 'Event', render: row => row.eventName },
                      { id: 'count', label: 'Count', numeric: true, render: row => row.count.toLocaleString() },
                    ]}
                  />
                ),
              }
        }
      />
    </Box>
  );
};
