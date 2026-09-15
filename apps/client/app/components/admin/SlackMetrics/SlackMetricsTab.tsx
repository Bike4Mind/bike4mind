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
} from 'recharts';
import type { ChartData } from '../EventMetrics/utils/chartDataProcessor';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

interface SlackMetricsTabProps {
  chartData: ChartData;
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8'];

export const SlackMetricsTab: React.FC<SlackMetricsTabProps> = ({ chartData }) => {
  const { slackMetrics } = chartData;

  const typeData = React.useMemo(
    () => (slackMetrics ? Object.entries(slackMetrics.eventsByType).map(([name, value]) => ({ name, value })) : []),
    [slackMetrics]
  );

  const formatData = React.useMemo(
    () => (slackMetrics ? Object.entries(slackMetrics.exportFormats).map(([name, value]) => ({ name, value })) : []),
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
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography level="h4">No Slack Data Available</Typography>
        <Typography sx={{ mt: 1 }}>Slack integration events will appear here once tracked.</Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
        <ContextHelpButton helpId="admin/metrics" tooltipText="Slack Metrics Help" />
      </Box>
      <Grid container spacing={2}>
        {/* Events Overview */}
        <Grid xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Slack Event Activity
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={typeData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis dataKey="name" type="category" width={180} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#8884d8" name="Count" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Agent Persona Distribution */}
        <Grid xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Agent Usage
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={agentData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={80}
                    fill="#8884d8"
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {agentData.map((entry, index) => (
                      <Cell key={`agent-${entry.name}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Intent Distribution */}
        <Grid xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Intent Breakdown
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={intentData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={80}
                    fill="#8884d8"
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {intentData.map((entry, index) => (
                      <Cell key={`intent-${entry.name}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Export Formats */}
        <Grid xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Export Formats
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={formatData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    fill="#8884d8"
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {formatData.map((entry, index) => (
                      <Cell key={`format-${entry.name}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        {/* Success Rate */}
        <Grid xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Export Success Rate
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={statusData} cx="50%" cy="50%" outerRadius={80} fill="#8884d8" dataKey="value">
                    <Cell fill="#00C49F" />
                    <Cell fill="#FF8042" />
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};
