import React, { useMemo } from 'react';
import { Box, Stack, Typography, useTheme } from '@mui/joy';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAnalyticsMetrics } from '@client/app/hooks/useAnalyticsMetrics';
import { processChartData } from '../utils/chartDataProcessor';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { DonutChart } from '@client/app/components/Charts/DonutChart';
import { TrendAreaChart } from '@client/app/components/Charts/TrendAreaChart';
import { ChartTooltipCard } from '@client/app/components/Charts/chartStyle';
import { INK, SURFACE } from '../../shared/chartParts';
import { adminChartSeries, adminChartStyle, adminChartTextOn } from '../../EventMetrics/utils/chartTheme';
import type { ChartData } from '../types';

// Past this many slices the opacity steps of the accent blur; switch to the chartSeries slots.
const ACCENT_STEP_MAX = 6;

/** Bars narrower or shorter than this, in px, carry no value label. */
const BAR_LABEL_SKIP = 12;

const ResponseTimeBarChart: React.FC<{ data: ChartData['performanceData'] }> = ({ data }) => {
  const style = adminChartStyle;
  const [color] = adminChartSeries(1);

  return (
    <Box data-testid="analytics-response-time-chart" sx={{ height: '100%', minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* recharts takes the gap on each side of a bar, so 20% leaves the bar 60% of its band. */}
        <BarChart data={[...data]} margin={{ top: 30, right: 50, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke={style.gridStroke} strokeDasharray={style.gridDash} />
          <XAxis
            dataKey="model"
            interval={0}
            angle={-45}
            textAnchor="end"
            height={80}
            tick={style.tick}
            tickLine={style.tickLine}
            tickSize={5}
            axisLine={false}
            label={{ value: 'Event Type', position: 'insideBottom', offset: 25, style: style.axisLabel }}
          />
          <YAxis
            width={80}
            domain={[0, 'auto']}
            tick={style.tick}
            tickLine={style.tickLine}
            tickSize={5}
            axisLine={false}
            label={{
              value: 'Response Time (ms)',
              angle: -90,
              position: 'insideLeft',
              offset: 30,
              style: { ...style.axisLabel, textAnchor: 'middle' },
            }}
          />
          <Tooltip
            shared={false}
            cursor={false}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as ChartData['performanceData'][number] | undefined;
              if (!active || !row) return null;
              return (
                <ChartTooltipCard
                  testId="analytics-response-time-chart-tooltip"
                  color={color}
                  label={`avgResponseTime - ${row.model}`}
                  value={row.avgResponseTime}
                />
              );
            }}
          />
          <Bar dataKey="avgResponseTime" fill={color} isAnimationActive={false}>
            <LabelList
              dataKey="avgResponseTime"
              content={({ x, y, width, height, value }) => {
                const w = Number(width);
                const h = Number(height);
                if (w < BAR_LABEL_SKIP || h < BAR_LABEL_SKIP) return null;
                return (
                  <text
                    x={Number(x) + w / 2}
                    y={Number(y) + h / 2}
                    fill={SURFACE}
                    fontSize={11}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {value}
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
};

interface AnalyticsTabProps {
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    userFilter?: string;
    modelFilter?: string;
    statusFilter?: string;
  };
}

export const AnalyticsTab: React.FC<AnalyticsTabProps> = ({ filters = {} }) => {
  const [trendColor] = adminChartSeries(1);

  const { data: analyticsMetrics = [], isLoading } = useAnalyticsMetrics(filters);
  const { data: modelInfos = [] } = useModelInfo();

  const chartData = useMemo(() => processChartData(analyticsMetrics, modelInfos, true), [analyticsMetrics, modelInfos]);
  const seriesPalette = useTheme().palette.admin.chartSeries;
  const sliceCount = chartData.modelUsageData.length;
  const fitsAccentSteps = sliceCount <= ACCENT_STEP_MAX;
  const donutColors = useMemo(
    () =>
      fitsAccentSteps
        ? adminChartSeries(sliceCount)
        : Array.from({ length: sliceCount }, (_, index) => seriesPalette[index % seriesPalette.length]),
    [fitsAccentSteps, sliceCount, seriesPalette]
  );
  const timeLegend = chartData.granularity === 'hourly' ? 'Time' : 'Date';

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
            <DonutChart
              testId="analytics-event-distribution-chart"
              data={chartData.modelUsageData}
              margin={{ top: 20, right: 80, bottom: 20, left: 80 }}
              colors={donutColors}
              valueColor={fitsAccentSteps ? index => adminChartTextOn(index, donutColors.length) : undefined}
              labelColor={INK}
              sliceStroke={SURFACE}
            />
          </Box>
        </Box>

        {/* Performance Bar Chart */}
        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }}>
            Response Time by Event Type
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            <ResponseTimeBarChart data={chartData.performanceData} />
          </Box>
        </Box>
      </Stack>

      {/* Row 2: Daily Usage Trends */}
      <Box sx={{ mt: 2, mb: 2 }}>
        <Typography level="h4" sx={{ mb: 2 }} data-testid="analytics-trends-heading">
          {chartData.granularity === 'hourly' ? 'Hourly' : 'Daily'} Analytics Trends
        </Typography>
        <Box sx={{ height: 300 }}>
          {chartData.dailyTrends[0]?.data?.length > 1 ? (
            <TrendAreaChart
              testId={`analytics-trend-${chartData.dailyTrends[0].id}`}
              data={chartData.dailyTrends[0].data}
              color={trendColor}
              style={adminChartStyle}
              xLegend={timeLegend}
              yLegend="Events"
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
              <TrendAreaChart
                testId={`analytics-trend-${chartData.contextRetrievalTrends[0].id}`}
                data={chartData.contextRetrievalTrends[0].data}
                color={trendColor}
                style={adminChartStyle}
                xLegend={timeLegend}
                yLegend="Avg Context Time (ms)"
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
              <TrendAreaChart
                testId={`analytics-trend-${chartData.firstTokenTrends[0].id}`}
                data={chartData.firstTokenTrends[0].data}
                color={trendColor}
                style={adminChartStyle}
                xLegend={timeLegend}
                yLegend="Avg First Token Time (ms)"
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
              <TrendAreaChart
                testId={`analytics-trend-${chartData.processPickupTrends[0].id}`}
                data={chartData.processPickupTrends[0].data}
                color={trendColor}
                style={adminChartStyle}
                xLegend={timeLegend}
                yLegend="Avg Pickup Time (ms)"
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

        <Box sx={{ flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}>
          <Typography level="h4" sx={{ mb: 2 }} data-testid="analytics-chars-per-second-heading">
            Characters Streamed Per Second
          </Typography>
          <Box sx={{ height: { xs: 220, sm: 300 } }}>
            {chartData.charactersPerSecondTrends[0]?.data?.length > 1 ? (
              <TrendAreaChart
                testId={`analytics-trend-${chartData.charactersPerSecondTrends[0].id}`}
                data={chartData.charactersPerSecondTrends[0].data}
                color={trendColor}
                style={adminChartStyle}
                xLegend={timeLegend}
                yLegend="Avg Chars/Second"
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
                <Typography
                  level="body-lg"
                  sx={{ color: 'text.primary', fontWeight: 'bold' }}
                  data-testid="analytics-chars-per-second-single"
                >
                  {chartData.charactersPerSecondTrends[0].data[0].y} chars/sec on{' '}
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
                <Typography
                  level="body-lg"
                  sx={{ color: 'text.secondary' }}
                  data-testid="analytics-chars-per-second-empty"
                >
                  No streaming speed data available
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </Stack>
    </>
  );
};
