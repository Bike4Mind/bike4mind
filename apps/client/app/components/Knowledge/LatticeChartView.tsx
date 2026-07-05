/**
 * LatticeChartView
 *
 * Chart visualization component for Lattice financial models.
 * Uses recharts to render time-series financial data.
 */

import React, { useState } from 'react';
import { Box, Stack, Typography, Select, Option, Chip } from '@mui/joy';
import { Theme } from '@mui/joy/styles';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import BarChartIcon from '@mui/icons-material/BarChart';
import StackedLineChartIcon from '@mui/icons-material/StackedLineChart';
import type { ILatticeModel, ILatticeComputedValues } from '@bike4mind/common';
import { useLatticeChartData } from '@client/app/hooks/useLatticeChartData';
import RechartsChart from '@client/app/components/Charts/RechartsChart';

export interface LatticeChartViewProps {
  model: ILatticeModel | null;
  /** Computed values from hydration - needed for displaying calculated data series */
  computedValues?: ILatticeComputedValues | null;
}

type ChartType = 'BarChart' | 'LineChart' | 'AreaChart';

const chartTypeOptions: { value: ChartType; label: string; icon: React.ReactNode }[] = [
  { value: 'BarChart', label: 'Bar Chart', icon: <BarChartIcon fontSize="small" /> },
  { value: 'LineChart', label: 'Line Chart', icon: <ShowChartIcon fontSize="small" /> },
  { value: 'AreaChart', label: 'Area Chart', icon: <StackedLineChartIcon fontSize="small" /> },
];

const LatticeChartView: React.FC<LatticeChartViewProps> = ({ model, computedValues }) => {
  const [chartType, setChartType] = useState<ChartType>('BarChart');

  const { chartConfig, periods, categories, hasTimeSeriesData } = useLatticeChartData(
    model,
    computedValues ?? null,
    chartType
  );

  if (!model) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 300,
        }}
      >
        <Typography level="body-lg" sx={{ color: 'text.tertiary' }}>
          Load a Lattice model to view charts
        </Typography>
      </Box>
    );
  }

  if (!hasTimeSeriesData || !chartConfig) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 300,
          gap: 2,
        }}
      >
        <Typography level="body-lg" sx={{ color: 'text.tertiary' }}>
          No time-series data available for charting
        </Typography>
        <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', maxWidth: 400 }}>
          To display charts, entities need &quot;period&quot;, &quot;category&quot;, and &quot;value&quot; attributes.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 2 }}>
      {/* Chart Controls */}
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        sx={(theme: Theme) => ({
          p: 1.5,
          borderRadius: 'sm',
          bgcolor: theme.palette.background.level1,
        })}
      >
        <Typography level="title-sm">Chart Type:</Typography>
        <Select
          value={chartType}
          onChange={(_, value) => value && setChartType(value as ChartType)}
          size="sm"
          sx={{ minWidth: 150 }}
          slotProps={{
            listbox: {
              sx: { zIndex: 1300 },
            },
          }}
        >
          {chartTypeOptions.map(option => (
            <Option key={option.value} value={option.value}>
              <Stack direction="row" spacing={1} alignItems="center">
                {option.icon}
                <span>{option.label}</span>
              </Stack>
            </Option>
          ))}
        </Select>

        <Box sx={{ flex: 1 }} />

        {/* Data Summary */}
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="sm" variant="soft" color="primary">
            {periods.length} periods
          </Chip>
          <Chip size="sm" variant="soft" color="neutral">
            {categories.length} categories
          </Chip>
        </Stack>
      </Stack>

      {/* Chart */}
      <Box
        sx={{
          flex: 1,
          minHeight: 400,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <RechartsChart config={chartConfig} title={chartConfig.title} description={chartConfig.description} />
      </Box>

      {/* Legend */}
      <Stack direction="row" spacing={2} flexWrap="wrap" justifyContent="center" sx={{ pt: 1, pb: 2 }}>
        {categories.map((category, index) => (
          <Stack key={category} direction="row" spacing={0.5} alignItems="center">
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: 2,
                bgcolor: chartConfig.config.colors?.[index] || '#8884d8',
              }}
            />
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              {category}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
};

export default LatticeChartView;
