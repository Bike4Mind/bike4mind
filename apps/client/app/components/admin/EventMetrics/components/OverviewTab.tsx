import React from 'react';
import { Box, Card, CardContent, Grid, Typography } from '@mui/joy';
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

export const OverviewTab: React.FC<OverviewTabProps> = ({
  chartData,
  showUsageBySource = true,
  isCompleteWindow = false,
}) => {
  const categoryColors = adminChartSeries(chartData.categoryBreakdown.length);
  return (
    <Box>
      <Grid container spacing={2}>
        {/* Usage by Source: web vs cli vs agent vs api at a glance. Its own
            admin endpoint, so it loads regardless of the filter state driving
            the rest of this tab. */}
        {showUsageBySource && (
          <Grid xs={12}>
            <UsageBySourceCard />
          </Grid>
        )}

        {/* Time Series Chart */}
        <Grid xs={12}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Events Over Time
                <AnalyticsTermHelp
                  term="Events Over Time"
                  description={
                    isCompleteWindow
                      ? 'Number of recorded events on each UTC date across the complete seven-day window. Every date is included, with zero for days without activity. Each event counts once, even if the same person acts repeatedly. Today is still in progress.'
                      : "Number of loaded events recorded on each date, using your browser's time zone. Each event counts once, even if the same person acts repeatedly. Dates with no loaded events are omitted. These counts reflect the loaded snapshot, not necessarily all activity in that period."
                  }
                />
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData.timeSeriesData}>
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
            </CardContent>
          </Card>
        </Grid>

        {/* Category Breakdown */}
        <Grid xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Events by Category
                <AnalyticsTermHelp
                  term="Events by Category"
                  description="Groups the events in this report by keywords in their names, such as Session, File or Auth. Each slice counts recorded events, not distinct users. Events whose names match none of these groups appear as Other."
                />
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={chartData.categoryBreakdown}
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
                    {chartData.categoryBreakdown.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={categoryColors[index]} />
                    ))}
                  </Pie>
                  <Tooltip {...chartTooltipProps} />
                  <Legend {...chartLegendProps} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Top Events */}
        <Grid xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Top 10 Events
                <AnalyticsTermHelp
                  term="Top 10 Events"
                  description="The ten most frequently recorded event names in this report. Each occurrence counts once. A feature can record several kinds of events, and one person can generate many events, so this is not a ranking of features by number of users."
                />
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData.topEvents.slice(0, 10)}>
                  <CartesianGrid {...chartGridProps} />
                  <XAxis dataKey="eventName" angle={-45} textAnchor="end" height={120} {...chartAxisProps} />
                  <YAxis {...chartAxisProps} />
                  <Tooltip {...chartTooltipProps} />
                  <Legend {...chartLegendProps} />
                  <Bar dataKey="count" fill={CHART_ACCENT} name="Count" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};
