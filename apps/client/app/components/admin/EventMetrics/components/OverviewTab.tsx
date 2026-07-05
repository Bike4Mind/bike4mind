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

interface OverviewTabProps {
  metrics: EventMetric[];
  chartData: ChartData;
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FFC658', '#FF6B6B'];

export const OverviewTab: React.FC<OverviewTabProps> = ({ metrics, chartData }) => {
  return (
    <Box>
      <Grid container spacing={2}>
        {/* Usage by Source: web vs cli vs agent vs api at a glance. Its own
            admin endpoint, so it loads regardless of the filter state driving
            the rest of this tab. */}
        <Grid xs={12}>
          <UsageBySourceCard />
        </Grid>

        {/* Time Series Chart */}
        <Grid xs={12}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Events Over Time
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
