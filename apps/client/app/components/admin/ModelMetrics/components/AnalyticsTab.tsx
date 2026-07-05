import React from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { ResponsivePie } from '@nivo/pie';
import { ResponsiveBar } from '@nivo/bar';
import { ResponsiveLine } from '@nivo/line';
import { useAnalyticsMetrics } from '@client/app/hooks/useAnalyticsMetrics';
import { processChartData } from '../utils/chartDataProcessor';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';

// Type assertion for Nivo components
const ResponsiveLineChart = ResponsiveLine as any;

interface AnalyticsTabProps {
  chartData: any; // Keep the original prop but use analytics data instead
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    userFilter?: string;
    modelFilter?: string;
    statusFilter?: string;
  };
}

export const AnalyticsTab: React.FC<AnalyticsTabProps> = ({ filters = {} }) => {
  const theme = useTheme();

  const { data: analyticsMetrics = [], isLoading } = useAnalyticsMetrics(filters);
  const { data: modelInfos = [] } = useModelInfo();

  const chartData = processChartData(analyticsMetrics, modelInfos, true);

  // Chart theme based on Joy UI colors
  const chartTheme = {
    axis: {
      ticks: {
        text: {
          fill: theme.palette.text.tertiary,
        },
      },
      legend: {
        text: {
          fill: theme.palette.text.primary,
        },
      },
    },
    grid: {
      line: {
        stroke: theme.palette.divider,
      },
    },
    tooltip: {
      container: {
        background: theme.palette.background.surface,
        color: theme.palette.text.primary,
        boxShadow: theme.shadow.md,
        borderRadius: theme.radius.md,
      },
    },
  };

  if (isLoading) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography>Loading analytics data...</Typography>
      </Box>
    );
  }

  return (
    <>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 2, mb: 2 }}>
        {/* Model Usage Pie Chart */}
        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }}>
            Analytics Event Distribution
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            <ResponsivePie
              data={chartData.modelUsageData}
              margin={{ top: 20, right: 80, bottom: 20, left: 80 }}
              innerRadius={0.5}
              padAngle={0.7}
              cornerRadius={3}
              activeOuterRadiusOffset={8}
              borderWidth={1}
              borderColor={{ from: 'color', modifiers: [['darker', 0.2]] }}
              arcLinkLabelsSkipAngle={10}
              arcLinkLabelsTextColor={theme.palette.text.primary}
              arcLinkLabelsThickness={2}
              arcLinkLabelsColor={{ from: 'color' }}
              arcLabelsSkipAngle={10}
              arcLabelsTextColor={{ from: 'color', modifiers: [['darker', 2]] }}
              theme={chartTheme}
            />
          </Box>
        </Box>

        {/* Performance Bar Chart */}
        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }}>
            Response Time by Event Type
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            <ResponsiveBar
              data={chartData.performanceData}
              keys={['avgResponseTime']}
              indexBy="model"
              margin={{ top: 30, right: 50, bottom: 80, left: 80 }}
              padding={0.4}
              colors={{ scheme: 'nivo' }}
              borderColor={{ from: 'color', modifiers: [['darker', 1.6]] }}
              axisTop={null}
              axisRight={null}
              axisBottom={{
                tickSize: 5,
                tickPadding: 5,
                tickRotation: -45,
                legend: 'Event Type',
                legendPosition: 'middle',
                legendOffset: 50,
              }}
              axisLeft={{
                tickSize: 5,
                tickPadding: 5,
                tickRotation: 0,
                legend: 'Response Time (ms)',
                legendPosition: 'middle',
                legendOffset: -40,
              }}
              labelSkipWidth={12}
              labelSkipHeight={12}
              labelTextColor={{ from: 'color', modifiers: [['darker', 1.6]] }}
              enableLabel={true}
              theme={chartTheme}
            />
          </Box>
        </Box>
      </Stack>

      {/* Row 2: Daily Usage Trends */}
      <Box sx={{ mt: 2, mb: 2 }}>
        <Typography level="h4" sx={{ mb: 2 }}>
          {chartData.dailyTrends[0]?.data?.[0]?.x?.includes(':') ? 'Hourly' : 'Daily'} Analytics Trends
        </Typography>
        <Box sx={{ height: 300 }}>
          {chartData.dailyTrends[0]?.data?.length > 1 ? (
            <ResponsiveLineChart
              data={chartData.dailyTrends}
              theme={chartTheme}
              margin={{ top: 20, right: 30, bottom: 70, left: 60 }}
              xScale={{ type: 'point' }}
              yScale={{
                type: 'linear',
                min: 'auto',
                max: 'auto',
              }}
              curve="catmullRom"
              axisTop={null}
              axisRight={null}
              axisBottom={{
                tickSize: 5,
                tickPadding: 5,
                tickRotation: -45,
                legend: chartData.dailyTrends[0]?.data?.[0]?.x?.includes(':') ? 'Time' : 'Date',
                legendPosition: 'middle',
                legendOffset: 55,
              }}
              axisLeft={{
                tickSize: 5,
                tickPadding: 5,
                tickRotation: 0,
                legend: 'Events',
                legendPosition: 'middle',
                legendOffset: -40,
              }}
              pointSize={8}
              pointColor={theme.palette.background.surface}
              pointBorderWidth={2}
              pointBorderColor={{ from: 'serieColor' }}
              enableArea={true}
              areaOpacity={0.15}
              useMesh={true}
              colors={[theme.palette.primary[500]]}
            />
          ) : chartData.dailyTrends[0]?.data?.length === 1 ? (
            <Box
              sx={{
                height: 250,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'background.level1',
                borderRadius: 'md',
                border: '1px dashed',
                borderColor: 'divider',
                gap: 1,
              }}
            >
              <Typography level="body-lg" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                {chartData.dailyTrends[0].data[0].y} events on {chartData.dailyTrends[0].data[0].x}
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                Select a wider date range (7d or 30d) to see daily trends
              </Typography>
            </Box>
          ) : (
            <Box
              sx={{
                height: 250,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'background.level1',
                borderRadius: 'md',
                border: '1px dashed',
                borderColor: 'divider',
              }}
            >
              <Typography level="body-lg" sx={{ color: 'text.secondary' }}>
                No analytics data available
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* Row 3: Context Retrieval and First Token Time Trends */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: { xs: 2, sm: 9 }, mb: 2 }}>
        {/* Context Retrieval Time Trends */}
        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }}>
            Context Retrieval Time
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            {chartData.contextRetrievalTrends[0]?.data?.length > 1 ? (
              <ResponsiveLineChart
                data={chartData.contextRetrievalTrends}
                theme={chartTheme}
                margin={{ top: 20, right: 30, bottom: 70, left: 60 }}
                xScale={{ type: 'point' }}
                yScale={{
                  type: 'linear',
                  min: 'auto',
                  max: 'auto',
                }}
                curve="catmullRom"
                axisTop={null}
                axisRight={null}
                axisBottom={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: -45,
                  legend: chartData.contextRetrievalTrends[0]?.data?.[0]?.x?.includes(':') ? 'Time' : 'Date',
                  legendPosition: 'middle',
                  legendOffset: 55,
                }}
                axisLeft={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: 0,
                  legend: 'Avg Context Time (ms)',
                  legendPosition: 'middle',
                  legendOffset: -40,
                }}
                pointSize={8}
                pointColor={theme.palette.background.surface}
                pointBorderWidth={2}
                pointBorderColor={{ from: 'serieColor' }}
                enableArea={true}
                areaOpacity={0.15}
                useMesh={true}
                colors={[theme.palette.success[500]]}
              />
            ) : chartData.contextRetrievalTrends[0]?.data?.length === 1 ? (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                  gap: 1,
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                  {chartData.contextRetrievalTrends[0].data[0].y}ms on {chartData.contextRetrievalTrends[0].data[0].x}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  Select a wider date range to see trends
                </Typography>
              </Box>
            ) : (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.secondary' }}>
                  No context retrieval data available
                </Typography>
              </Box>
            )}
          </Box>
        </Box>

        {/* First Token Time Trends */}
        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }}>
            First Response Time
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            {chartData.firstTokenTrends[0]?.data?.length > 1 ? (
              <ResponsiveLineChart
                data={chartData.firstTokenTrends}
                theme={chartTheme}
                margin={{ top: 20, right: 30, bottom: 70, left: 60 }}
                xScale={{ type: 'point' }}
                yScale={{
                  type: 'linear',
                  min: 'auto',
                  max: 'auto',
                }}
                curve="catmullRom"
                axisTop={null}
                axisRight={null}
                axisBottom={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: -45,
                  legend: chartData.firstTokenTrends[0]?.data?.[0]?.x?.includes(':') ? 'Time' : 'Date',
                  legendPosition: 'middle',
                  legendOffset: 55,
                }}
                axisLeft={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: 0,
                  legend: 'Avg First Token Time (ms)',
                  legendPosition: 'middle',
                  legendOffset: -40,
                }}
                pointSize={8}
                pointColor={theme.palette.background.surface}
                pointBorderWidth={2}
                pointBorderColor={{ from: 'serieColor' }}
                enableArea={true}
                areaOpacity={0.15}
                useMesh={true}
                colors={[theme.palette.warning[500]]}
              />
            ) : chartData.firstTokenTrends[0]?.data?.length === 1 ? (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                  gap: 1,
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                  {chartData.firstTokenTrends[0].data[0].y}ms on {chartData.firstTokenTrends[0].data[0].x}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  Select a wider date range to see trends
                </Typography>
              </Box>
            ) : (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.secondary' }}>
                  No first token data available
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Stack>

      {/* Row 4: Characters Streamed Per Second and Process Pickup Time Trends */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: { xs: 2, sm: 9 }, mb: 2 }}>
        {/* Process Pickup Time Trends */}
        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }}>
            Process/Queue Pickup Time
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            {chartData.processPickupTrends[0]?.data?.length > 1 ? (
              <ResponsiveLineChart
                data={chartData.processPickupTrends}
                theme={chartTheme}
                margin={{ top: 20, right: 30, bottom: 70, left: 60 }}
                xScale={{ type: 'point' }}
                yScale={{
                  type: 'linear',
                  min: 'auto',
                  max: 'auto',
                }}
                curve="catmullRom"
                axisTop={null}
                axisRight={null}
                axisBottom={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: -45,
                  legend: chartData.processPickupTrends[0]?.data?.[0]?.x?.includes(':') ? 'Time' : 'Date',
                  legendPosition: 'middle',
                  legendOffset: 55,
                }}
                axisLeft={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: 0,
                  legend: 'Avg Pickup Time (ms)',
                  legendPosition: 'middle',
                  legendOffset: -40,
                }}
                pointSize={8}
                pointColor={theme.palette.background.surface}
                pointBorderWidth={2}
                pointBorderColor={{ from: 'serieColor' }}
                enableArea={true}
                areaOpacity={0.15}
                useMesh={true}
                colors={[theme.palette.neutral[500]]}
              />
            ) : chartData.processPickupTrends[0]?.data?.length === 1 ? (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                  gap: 1,
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                  {chartData.processPickupTrends[0].data[0].y}ms on {chartData.processPickupTrends[0].data[0].x}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  Select a wider date range to see trends
                </Typography>
              </Box>
            ) : (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.secondary' }}>
                  No process pickup data available
                </Typography>
              </Box>
            )}
          </Box>
        </Box>

        {/* Characters Streamed Per Second Trends */}
        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }}>
            Analytics Event Frequency
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            {chartData.charactersPerSecondTrends[0]?.data?.length > 1 ? (
              <ResponsiveLineChart
                data={chartData.charactersPerSecondTrends}
                theme={chartTheme}
                margin={{ top: 20, right: 30, bottom: 70, left: 60 }}
                xScale={{ type: 'point' }}
                yScale={{
                  type: 'linear',
                  min: 'auto',
                  max: 'auto',
                }}
                curve="catmullRom"
                axisTop={null}
                axisRight={null}
                axisBottom={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: -45,
                  legend: chartData.charactersPerSecondTrends[0]?.data?.[0]?.x?.includes(':') ? 'Time' : 'Date',
                  legendPosition: 'middle',
                  legendOffset: 55,
                }}
                axisLeft={{
                  tickSize: 5,
                  tickPadding: 5,
                  tickRotation: 0,
                  legend: 'Events per Hour',
                  legendPosition: 'middle',
                  legendOffset: -40,
                }}
                pointSize={8}
                pointColor={theme.palette.background.surface}
                pointBorderWidth={2}
                pointBorderColor={{ from: 'serieColor' }}
                enableArea={true}
                areaOpacity={0.15}
                useMesh={true}
                colors={[theme.palette.primary[300]]}
              />
            ) : chartData.charactersPerSecondTrends[0]?.data?.length === 1 ? (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                  gap: 1,
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                  {chartData.charactersPerSecondTrends[0].data[0].y} events/hr on{' '}
                  {chartData.charactersPerSecondTrends[0].data[0].x}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  Select a wider date range to see trends
                </Typography>
              </Box>
            ) : (
              <Box
                sx={{
                  height: 250,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'background.level1',
                  borderRadius: 'md',
                  border: '1px dashed',
                  borderColor: 'divider',
                }}
              >
                <Typography level="body-lg" sx={{ color: 'text.secondary' }}>
                  No analytics frequency data available
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Stack>
    </>
  );
};
