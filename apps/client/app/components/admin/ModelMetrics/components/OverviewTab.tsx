import React from 'react';
import { Box, Stack, Typography, Divider } from '@mui/joy';
import { ModelMetric } from '../types';
import { ChartData } from '../utils/chartDataProcessor';

interface OverviewTabProps {
  metrics: ModelMetric[];
  chartData: ChartData;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ metrics, chartData }) => {
  return (
    <Stack spacing={3}>
      {/* Summary Cards */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
          gap: 2,
        }}
      >
        <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
          <Typography level="title-lg">{chartData.modelUsageData.length}</Typography>
          <Typography level="body-sm">Different Models Used</Typography>
        </Box>

        <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
          <Typography level="title-lg">
            {chartData.performanceData.length > 0
              ? Math.round(
                  chartData.performanceData.reduce((sum, item) => sum + item.avgResponseTime, 0) /
                    chartData.performanceData.length
                )
              : 0}
            ms
          </Typography>
          <Typography level="body-sm">Avg Response Time</Typography>
        </Box>

        <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
          <Typography level="title-lg">{metrics.length}</Typography>
          <Typography level="body-sm">Total Requests</Typography>
        </Box>

        <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
          <Typography level="title-lg">
            {metrics.reduce((sum, m) => sum + (m.tokenUsage?.creditsUsed || 0), 0).toFixed(0)}
          </Typography>
          <Typography level="body-sm">Total Credits Used</Typography>
        </Box>
      </Box>

      {/* Model Usage Breakdown */}
      <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
        <Typography level="h4" sx={{ mb: 2 }}>
          Model Usage Breakdown
        </Typography>
        <Stack spacing={1}>
          {chartData.modelUsageData.map((model, index) => (
            <React.Fragment key={model.id}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                spacing={{ xs: 0.5, sm: 0 }}
              >
                <Typography level="body-sm">{model.label}</Typography>
                <Stack direction="row" spacing={2} alignItems="center">
                  <Typography level="body-sm">{model.value} requests</Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    {model.percentage}%
                  </Typography>
                </Stack>
              </Stack>
              {index < chartData.modelUsageData.length - 1 && <Divider sx={{ display: { xs: 'block', sm: 'none' } }} />}
            </React.Fragment>
          ))}
        </Stack>
      </Box>

      {/* Performance by Model */}
      <Box sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
        <Typography level="h4" sx={{ mb: 2 }}>
          Performance by Model
        </Typography>
        <Stack spacing={1}>
          {chartData.performanceData.map((perf, index) => (
            <React.Fragment key={perf.model}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                spacing={{ xs: 0.5, sm: 0 }}
              >
                <Typography level="body-sm">{perf.model}</Typography>
                <Stack direction="row" spacing={2} alignItems="center">
                  <Typography level="body-sm">{perf.avgResponseTime}ms avg</Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    {perf.count} requests
                  </Typography>
                </Stack>
              </Stack>
              {index < chartData.performanceData.length - 1 && (
                <Divider sx={{ display: { xs: 'block', sm: 'none' } }} />
              )}
            </React.Fragment>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
};
