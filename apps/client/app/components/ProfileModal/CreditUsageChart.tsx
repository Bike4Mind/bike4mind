import React, { useMemo } from 'react';
import { Box, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useChartStyle } from '@client/app/components/Charts/chartStyle';
import { getCreditSeriesLabel } from './creditChartLabels';

export type CreditSeries = { id: string; data: Array<{ x: string; y: number }>; color: string };

type Row = { x: string } & Record<string, number | string>;

const MS_PER_DAY = 86_400_000;

/**
 * Every `everyDays`-th day, counted in whole days since the epoch so the ticks stay put as the range
 * slides; `x` is a local `YYYY-MM-DD`.
 */
export const isDayTick = (x: string, everyDays: number): boolean =>
  Math.floor(dayjs(x).valueOf() / MS_PER_DAY) % everyDays === 0;

/** One row per day with a column per series id, oldest first. */
export const toRows = (series: readonly CreditSeries[]): Row[] => {
  const byDay = new Map<string, Row>();
  for (const s of series) {
    for (const point of s.data) {
      const row: Row = byDay.get(point.x) ?? { x: point.x };
      row[s.id] = point.y;
      byDay.set(point.x, row);
    }
  }
  return [...byDay.values()].sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
};

type TooltipEntry = { dataKey?: unknown; value?: unknown; payload?: Row };

/** Lists every series on the hovered day, named the way the series picker names them. */
export const CreditUsageTooltip: React.FC<{ active?: boolean; payload?: readonly TooltipEntry[] }> = ({
  active,
  payload,
}) => {
  const { t } = useTranslation();
  const day = payload?.[0]?.payload?.x;
  if (!active || !payload?.length || !day) return null;
  return (
    <Box
      data-testid="credit-usage-chart-tooltip"
      sx={{
        p: 1,
        bgcolor: 'background.surface',
        borderRadius: 'sm',
        boxShadow: 'sm',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Typography level="body-xs">
        <strong>{dayjs(day).format('MMM D, YYYY')}</strong>
      </Typography>
      {payload.map(entry => (
        <Typography key={String(entry.dataKey)} level="body-xs">
          {getCreditSeriesLabel(String(entry.dataKey), t)}: <strong>{Number(entry.value).toLocaleString()}</strong>{' '}
          {t('credits.credits')}
        </Typography>
      ))}
    </Box>
  );
};

interface CreditUsageChartProps {
  series: readonly CreditSeries[];
  yLegend: string;
  xLegend: string;
  /** Days between x ticks. */
  tickEveryDays: number;
  /** Point diameter in px; 0 hides the points. */
  pointSize: number;
}

/** Daily credit series as overlapping areas on one time axis. Fills its parent. */
export const CreditUsageChart: React.FC<CreditUsageChartProps> = ({
  series,
  yLegend,
  xLegend,
  tickEveryDays,
  pointSize,
}) => {
  const theme = useTheme();
  const style = useChartStyle();
  const rows = useMemo(() => toRows(series), [series]);
  const ticks = useMemo(() => rows.map(row => row.x).filter(x => isDayTick(x, tickEveryDays)), [rows, tickEveryDays]);
  // Drawn in reverse so the first series paints on top; the tooltip lists them in this order too.
  const drawOrder = useMemo(() => [...series].reverse(), [series]);

  return (
    <Box data-testid="credit-usage-chart" sx={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 20, right: 30, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={style.gridStroke} />
          <XAxis
            dataKey="x"
            ticks={ticks}
            interval={0}
            height={45}
            tick={style.tick}
            tickLine={style.tickLine}
            tickSize={5}
            axisLine={false}
            tickFormatter={(x: string) => dayjs(x).format('MMM DD')}
            label={{ value: xLegend, position: 'insideBottom', offset: 10, style: style.axisLabel }}
          />
          <YAxis
            domain={['auto', 'auto']}
            width={60}
            tick={style.tick}
            tickLine={style.tickLine}
            tickSize={5}
            axisLine={false}
            label={{
              value: yLegend,
              angle: -90,
              position: 'insideLeft',
              offset: 5,
              style: { ...style.axisLabel, textAnchor: 'middle' },
            }}
          />
          <Tooltip
            cursor={{
              stroke: theme.palette.primary.solidBg,
              strokeWidth: 1,
              strokeOpacity: 0.5,
              strokeDasharray: '6 6',
            }}
            content={({ active, payload }) => <CreditUsageTooltip active={active} payload={payload} />}
          />
          {drawOrder.map(s => (
            <Area
              key={s.id}
              type="monotone"
              dataKey={s.id}
              stroke={s.color}
              strokeWidth={2}
              fill={s.color}
              fillOpacity={0.15}
              dot={pointSize > 0 ? { r: pointSize / 2, fill: style.surface, stroke: s.color, strokeWidth: 2 } : false}
              activeDot={{ r: Math.max(pointSize / 2, 3), fill: style.surface, stroke: s.color, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
};
