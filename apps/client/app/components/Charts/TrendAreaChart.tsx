import React from 'react';
import { Box } from '@mui/joy';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipCard, useChartStyle, type ChartStyle } from './chartStyle';

export type TrendPoint = { x: string; y: number };

interface TrendAreaChartProps {
  /** Lands on the chart box; the tooltip takes `${testId}-tooltip`. */
  testId: string;
  data: readonly TrendPoint[];
  color: string;
  xLegend: string;
  yLegend: string;
  /** Point diameter in px; 0 hides the points. */
  pointSize?: number;
  formatX?: (value: string) => string;
  formatY?: (value: number) => string;
  /** Room for the y tick labels and legend, in px. */
  yAxisWidth?: number;
  /** Axis and grid styling; defaults to the Joy theme's. */
  style?: ChartStyle;
}

export const TrendTooltip: React.FC<{
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  color: string;
  testId: string;
}> = ({ active, payload, color, testId }) => {
  const point = payload?.[0]?.payload as TrendPoint | undefined;
  if (!active || !point) return null;
  return (
    <ChartTooltipCard
      testId={testId}
      color={color}
      label={
        <>
          x: <strong>{point.x}</strong>, y: <strong>{point.y}</strong>
        </>
      }
    />
  );
};

/** One series over evenly spaced category ticks, drawn as a line with a light area under it. Fills its parent. */
export const TrendAreaChart: React.FC<TrendAreaChartProps> = ({
  testId,
  data,
  color,
  xLegend,
  yLegend,
  pointSize = 8,
  formatX,
  formatY,
  yAxisWidth = 60,
  style: styleProp,
}) => {
  const themeStyle = useChartStyle();
  const style = styleProp ?? themeStyle;
  const dot = pointSize > 0 ? { r: pointSize / 2, fill: style.surface, stroke: color, strokeWidth: 2 } : false;

  return (
    <Box data-testid={testId} sx={{ height: '100%', minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={[...data]} margin={{ top: 20, right: 30, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={style.gridStroke} strokeDasharray={style.gridDash} />
          <XAxis
            dataKey="x"
            interval={0}
            angle={-45}
            textAnchor="end"
            height={70}
            tick={style.tick}
            tickLine={style.tickLine}
            tickSize={5}
            axisLine={false}
            tickFormatter={formatX}
            label={{ value: xLegend, position: 'insideBottom', offset: 5, style: style.axisLabel }}
          />
          <YAxis
            domain={['auto', 'auto']}
            width={yAxisWidth}
            tick={style.tick}
            tickLine={style.tickLine}
            tickSize={5}
            axisLine={false}
            tickFormatter={formatY}
            label={{
              value: yLegend,
              angle: -90,
              position: 'insideLeft',
              offset: 10,
              style: { ...style.axisLabel, textAnchor: 'middle' },
            }}
          />
          <Tooltip
            cursor={{ stroke: style.cursorStroke, strokeWidth: 1, strokeDasharray: '6 6' }}
            content={({ active, payload }) => (
              <TrendTooltip active={active} payload={payload} color={color} testId={`${testId}-tooltip`} />
            )}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={color}
            strokeWidth={2}
            fill={color}
            fillOpacity={0.15}
            dot={dot}
            activeDot={dot || { r: 3, fill: style.surface, stroke: color, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
};
