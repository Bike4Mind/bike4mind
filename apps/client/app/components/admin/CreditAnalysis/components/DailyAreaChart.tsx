import React from 'react';
import { Box, useTheme } from '@mui/joy';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type DailyAreaChartProps = {
  data: { day: string; value: number }[];
  valueLabel: string;
  formatValue: (value: number) => string;
  color: 'primary' | 'warning';
  height?: number;
  testid?: string;
};

export const DailyAreaChart: React.FC<DailyAreaChartProps> = ({
  data,
  valueLabel,
  formatValue,
  color,
  height = 240,
  testid,
}) => {
  const theme = useTheme();
  return (
    <Box data-testid={testid}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis tick={{ fontSize: 11 }} width={56} />
          <Tooltip
            formatter={value => [formatValue(Number(value) || 0), valueLabel]}
            contentStyle={{
              background: theme.palette.background.surface,
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={theme.palette[color][500]}
            fill={theme.palette[color].softBg}
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
};
