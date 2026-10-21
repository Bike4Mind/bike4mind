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
import type { EventMetric } from '../types';
import type { ChartData } from '../utils/chartDataProcessor';
import { UsageBySourceCard } from './UsageBySourceCard';
import { AnalyticsTermHelp } from './AnalyticsTermHelp';

interface OverviewTabProps {
  metrics: EventMetric[];
  chartData: ChartData;
  showUsageBySource?: boolean;
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FFC658', '#FF6B6B'];

export const OverviewTab: React.FC<OverviewTabProps> = ({ metrics, chartData, showUsageBySource = true }) => {
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
                  description="Number of loaded events recorded on each date, using your browser's time zone. Each event counts once, even if the same person acts repeatedly. Dates with no loaded events are omitted. These counts reflect the loaded snapshot, not necessarily all activity in that period."
                />
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData.timeSeriesData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="count" stroke="#8884d8" name="Event Count" />
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
                  description="Groups the loaded events into related types of activity. For example, message actions may share a category. Each slice counts recorded events, not distinct users. Events with no category appear as Other."
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
                    label={entry => {
                      const { category, count } = entry as PieLabelRenderProps & {
                        category: string;
                        count: number;
                      };
                      return `${category}: ${count}`;
                    }}
                  >
                    {chartData.categoryBreakdown.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
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
                  description="The ten most frequently recorded event names in the loaded snapshot. Each occurrence counts once. A feature can record several kinds of events, and one person can generate many events, so this is not a ranking of features by number of users."
                />
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData.topEvents.slice(0, 10)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="eventName" angle={-45} textAnchor="end" height={120} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" fill="#8884d8" name="Count" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};
