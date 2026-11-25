import React from 'react';
import { Box } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import {
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  Tooltip,
  type PieLabelRenderProps,
  type PieSectorShapeProps,
} from 'recharts';
import { ChartTooltipCard, categoryColor, darken } from './chartStyle';

export type DonutDatum = { id: string; label: string; value: number };

const RADIAN = Math.PI / 180;
/** Slices thinner than this get no labels; the tooltip still names them. */
const LABEL_SKIP_ANGLE = 10;
const LINK_DIAGONAL = 16;
const LINK_STRAIGHT = 24;
const LINK_TEXT_OFFSET = 6;
/** How far the hovered slice grows past the others, in px. */
const ACTIVE_OFFSET = 8;

interface DonutChartProps {
  /** Lands on the chart box; the default tooltip takes `${testId}-tooltip`. */
  testId: string;
  data: readonly DonutDatum[];
  margin: { top: number; right: number; bottom: number; left: number };
  /** Replaces the default `label: value` tooltip body. */
  renderTooltip?: (datum: DonutDatum, color: string) => React.ReactNode;
  /** Slice colors in data order; defaults to CATEGORY_COLORS. */
  colors?: readonly string[];
  /** Color of the value drawn inside slice `index`; defaults to a darkened slice color. */
  valueColor?: (index: number) => string;
  /** Color of the outside labels; defaults to the theme's primary text. */
  labelColor?: string;
  /** Slice edge color; defaults to a darkened slice color. */
  sliceStroke?: string;
}

const colorAt = (colors: readonly string[] | undefined, index: number) =>
  colors && colors.length > 0 ? colors[index % colors.length] : categoryColor(index);

export const DonutTooltip: React.FC<{
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  data: readonly DonutDatum[];
  testId: string;
  renderTooltip?: DonutChartProps['renderTooltip'];
  colors?: readonly string[];
}> = ({ active, payload, data, testId, renderTooltip, colors }) => {
  const datum = payload?.[0]?.payload as DonutDatum | undefined;
  if (!active || !datum) return null;
  const color = colorAt(
    colors,
    data.findIndex(d => d.id === datum.id)
  );
  return renderTooltip ? (
    renderTooltip(datum, color)
  ) : (
    <ChartTooltipCard testId={testId} color={color} label={datum.id} value={datum.value} />
  );
};

/**
 * A half-depth donut with the value inside each slice and the label linked outside it, first slice at
 * 12 o'clock going clockwise. Colors follow `colors` (default CATEGORY_COLORS) in data order. Fills its parent.
 */
export const DonutChart: React.FC<DonutChartProps> = ({
  testId,
  data,
  margin,
  renderTooltip,
  colors,
  valueColor,
  labelColor: labelColorProp,
  sliceStroke,
}) => {
  const theme = useTheme();
  const labelColor = labelColorProp ?? theme.palette.text.primary;

  const renderLabel = (props: PieLabelRenderProps) => {
    const { cx, cy, midAngle, startAngle, endAngle, index } = props;
    const innerRadius = Number(props.innerRadius);
    const outerRadius = Number(props.outerRadius);
    const datum = data[index];
    if (!datum || Math.abs(Number(endAngle) - Number(startAngle)) < LABEL_SKIP_ANGLE) return null;

    const color = colorAt(colors, index);
    const cos = Math.cos(-Number(midAngle) * RADIAN);
    const sin = Math.sin(-Number(midAngle) * RADIAN);
    const centerX = Number(cx);
    const centerY = Number(cy);
    const valueRadius = innerRadius + (outerRadius - innerRadius) / 2;
    const side = cos >= 0 ? 1 : -1;
    const start = { x: centerX + outerRadius * cos, y: centerY + outerRadius * sin };
    const bend = { x: centerX + (outerRadius + LINK_DIAGONAL) * cos, y: centerY + (outerRadius + LINK_DIAGONAL) * sin };
    const end = { x: bend.x + LINK_STRAIGHT * side, y: bend.y };

    return (
      <g>
        <text
          x={centerX + valueRadius * cos}
          y={centerY + valueRadius * sin}
          fill={valueColor ? valueColor(index) : darken(color, 2)}
          fontSize={11}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {datum.value}
        </text>
        <polyline
          points={`${start.x},${start.y} ${bend.x},${bend.y} ${end.x},${end.y}`}
          fill="none"
          stroke={color}
          strokeWidth={2}
        />
        <text
          x={end.x + LINK_TEXT_OFFSET * side}
          y={end.y}
          fill={labelColor}
          fontSize={11}
          textAnchor={side > 0 ? 'start' : 'end'}
          dominantBaseline="central"
        >
          {datum.label}
        </text>
      </g>
    );
  };

  return (
    <Box data-testid={testId} sx={{ height: '100%', minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={margin}>
          <Tooltip
            content={({ active, payload }) => (
              <DonutTooltip
                active={active}
                payload={payload}
                data={data}
                testId={`${testId}-tooltip`}
                renderTooltip={renderTooltip}
                colors={colors}
              />
            )}
          />
          <Pie
            data={[...data]}
            dataKey="value"
            nameKey="label"
            innerRadius="50%"
            outerRadius="100%"
            startAngle={90}
            endAngle={-270}
            paddingAngle={0.7}
            cornerRadius={3}
            label={renderLabel}
            labelLine={false}
            shape={(props: PieSectorShapeProps) => (
              <Sector
                {...props}
                fill={colorAt(colors, props.index)}
                stroke={sliceStroke ?? darken(colorAt(colors, props.index), 0.2)}
                strokeWidth={1}
                outerRadius={props.isActive ? props.outerRadius + ACTIVE_OFFSET : props.outerRadius}
              />
            )}
            isAnimationActive={false}
          />
        </PieChart>
      </ResponsiveContainer>
    </Box>
  );
};
