import React, { type ReactNode } from 'react';
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
import { EmptyState } from '../shared';

interface SlackMetricsTabProps {
  chartData: ChartData;
  /** The page's range or filters are set, so an empty view may be down to them. */
  filtered: boolean;
  /** The empty state's next step: Clear filters when `filtered`, else a refresh. */
  emptyAction: ReactNode;
}

export const SlackMetricsTab: React.FC<SlackMetricsTabProps> = ({ chartData, filtered, emptyAction }) => {
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

  return (
    <Box>
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
                  <CartesianGrid {...chartGridProps} />
                  <XAxis type="number" {...chartAxisProps} />
                  <YAxis dataKey="name" type="category" width={180} {...chartAxisProps} />
                  <Tooltip {...chartTooltipProps} />
                  <Bar dataKey="value" fill={CHART_ACCENT} name="Count" />
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
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};
