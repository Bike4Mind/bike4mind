import React from 'react';
import { Box, Stack } from '@mui/joy';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RevenueTrendPoint } from '@bike4mind/server-utils/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@bike4mind/server-utils/app/utils/adminSubscriptionsFilter';
import { formatMoney } from '../shared/formatMoney';
import {
  ACCENT,
  BAD,
  BORDER,
  COMPARISON_OPACITY,
  ChartLegend,
  ChartTooltipBox,
  GOOD,
  INK,
  INK_MUTED,
  WARN,
  xAxisProps,
  yAxisProps,
  type ChartLegendItem,
  type ChartTooltipLine,
} from './chartParts';
import { OTHER_PLANS_KEY, type PlanPoint, type PlanSeries, type RevenuePeriod } from './revenueChartData';
import { formatTrendDay } from './revenueFormat';

const CHART_HEIGHT = 200;
const MOVEMENT_TEST_ID = 'admin-revenue-movement-chart';
const BY_PLAN_TEST_ID = 'admin-revenue-by-plan-chart';
const BY_OWNER_TEST_ID = 'admin-revenue-by-owner-chart';
const AT_RISK_TEST_ID = 'admin-revenue-at-risk-chart';
const SURFACE = 'var(--joy-palette-admin-surface)';

const money = (amount: number) => formatMoney(amount, MRR_CURRENCY);
const compactMoney = (amount: number) => formatMoney(amount, MRR_CURRENCY, { compact: true });

type TooltipProps<Row> = { active?: boolean; payload?: Array<{ payload: Row }> };

/** Builds a recharts tooltip from a row; recharts clones `content`, so it must be an element. */
function tooltipFor<Row>(testId: string, render: (row: Row) => { title: string; lines: ChartTooltipLine[] }) {
  const ChartTooltip = ({ active, payload }: TooltipProps<Row>) => {
    const row = payload?.[0]?.payload;
    if (!active || !row) return null;
    const { title, lines } = render(row);
    return <ChartTooltipBox testId={testId} title={title} lines={lines} />;
  };
  return <ChartTooltip />;
}

const ChartFrame: React.FC<{ testId: string; legend: readonly ChartLegendItem[]; children: React.ReactElement }> = ({
  testId,
  legend,
  children,
}) => (
  <Stack gap={1}>
    <Box data-testid={testId} sx={{ height: CHART_HEIGHT, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </Box>
    <ChartLegend testId={testId} items={legend} />
  </Stack>
);

const MOVEMENT_LEGEND: ChartLegendItem[] = [
  { label: 'New MRR', color: GOOD },
  { label: 'Churned MRR', color: BAD },
  { label: 'Net', color: INK },
];

/** Diverging bars: new above zero, churned below, net as a line. */
export const MrrMovementChart: React.FC<{ periods: readonly RevenuePeriod[] }> = ({ periods }) => (
  <ChartFrame testId={MOVEMENT_TEST_ID} legend={MOVEMENT_LEGEND}>
    <ComposedChart
      data={periods.map(period => ({ ...period, churnedBelow: -period.churnedMrr }))}
      stackOffset="sign"
      margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
    >
      <CartesianGrid vertical={false} stroke={BORDER} />
      <XAxis dataKey="label" {...xAxisProps} />
      <YAxis tickFormatter={compactMoney} width={72} {...yAxisProps} />
      <ReferenceLine y={0} stroke={INK_MUTED} />
      <Tooltip
        cursor={{ fill: BORDER, fillOpacity: 0.4 }}
        content={tooltipFor<RevenuePeriod>(MOVEMENT_TEST_ID, period => ({
          title: period.label,
          lines: [
            { label: 'New', value: money(period.newMrr), color: GOOD },
            { label: 'Churned', value: money(-period.churnedMrr), color: BAD },
            { label: 'Net', value: money(period.net), color: INK },
          ],
        }))}
      />
      <Bar dataKey="newMrr" name="New MRR" stackId="movement" fill={GOOD} isAnimationActive={false} />
      <Bar dataKey="churnedBelow" name="Churned MRR" stackId="movement" fill={BAD} isAnimationActive={false} />
      <Line
        dataKey="net"
        name="Net"
        stroke={INK}
        strokeWidth={2}
        dot={periods.length === 1}
        isAnimationActive={false}
      />
    </ComposedChart>
  </ChartFrame>
);

// One hue (DESIGN_GUIDE: plans are not statuses), stepped down by size; "Other plans" is the comparison grey.
const PLAN_OPACITY = [1, 0.75, 0.55, 0.4, 0.25];

export const planColor = (series: readonly PlanSeries[], key: string): { color: string; opacity: number } =>
  key === OTHER_PLANS_KEY
    ? { color: INK_MUTED, opacity: COMPARISON_OPACITY }
    : { color: ACCENT, opacity: PLAN_OPACITY[series.findIndex(entry => entry.key === key)] ?? 0.25 };

export const MrrByPlanChart: React.FC<{ points: readonly PlanPoint[]; series: readonly PlanSeries[] }> = ({
  points,
  series,
}) => (
  <ChartFrame
    testId={BY_PLAN_TEST_ID}
    legend={series.map(entry => ({ label: entry.label, ...planColor(series, entry.key) }))}
  >
    <AreaChart data={[...points]} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={BORDER} />
      <XAxis dataKey="date" tickFormatter={formatTrendDay} {...xAxisProps} />
      <YAxis tickFormatter={compactMoney} width={72} {...yAxisProps} />
      <Tooltip
        cursor={{ stroke: BORDER }}
        content={tooltipFor<PlanPoint>(BY_PLAN_TEST_ID, point => ({
          title: formatTrendDay(point.date),
          lines: [
            ...series.map(entry => ({
              label: entry.label,
              value: money(point.values[entry.key] ?? 0),
              ...planColor(series, entry.key),
            })),
            { label: 'Total', value: money(point.total) },
          ],
        }))}
      />
      {/* Largest plan at the bottom of the stack; the surface-colored stroke divides the bands. */}
      {series.map(entry => {
        const { color, opacity } = planColor(series, entry.key);
        return (
          <Area
            key={entry.key}
            dataKey={(point: PlanPoint) => point.values[entry.key] ?? 0}
            name={entry.label}
            stackId="plans"
            type="monotone"
            fill={color}
            fillOpacity={opacity}
            stroke={SURFACE}
            strokeWidth={1}
            isAnimationActive={false}
          />
        );
      })}
    </AreaChart>
  </ChartFrame>
);

const OWNER_LEGEND: ChartLegendItem[] = [
  { label: 'Individuals', color: ACCENT },
  { label: 'Organizations', color: INK_MUTED, opacity: COMPARISON_OPACITY },
];

export const PayingByOwnerChart: React.FC<{ periods: readonly RevenuePeriod[] }> = ({ periods }) => (
  <ChartFrame testId={BY_OWNER_TEST_ID} legend={OWNER_LEGEND}>
    <BarChart data={[...periods]} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={BORDER} />
      <XAxis dataKey="label" {...xAxisProps} />
      <YAxis allowDecimals={false} width={48} {...yAxisProps} />
      <Tooltip
        cursor={{ fill: BORDER, fillOpacity: 0.4 }}
        content={tooltipFor<RevenuePeriod>(BY_OWNER_TEST_ID, period => ({
          title: period.label,
          lines: [
            { label: 'Individuals', value: period.payingUsers.toLocaleString(), color: ACCENT },
            {
              label: 'Organizations',
              value: period.payingOrgs.toLocaleString(),
              color: INK_MUTED,
              opacity: COMPARISON_OPACITY,
            },
          ],
        }))}
      />
      <Bar dataKey="payingUsers" name="Individuals" stackId="owners" fill={ACCENT} isAnimationActive={false} />
      <Bar
        dataKey="payingOrgs"
        name="Organizations"
        stackId="owners"
        fill={INK_MUTED}
        fillOpacity={COMPARISON_OPACITY}
        isAnimationActive={false}
      />
    </BarChart>
  </ChartFrame>
);

const AT_RISK_LEGEND: ChartLegendItem[] = [
  { label: 'Past due', color: WARN, opacity: 0.6 },
  { label: 'Canceling', color: WARN, dashed: true },
];

// Not stacked: the snapshot stores the two separately, and a row can be both.
export const AtRiskChart: React.FC<{ points: readonly RevenueTrendPoint[] }> = ({ points }) => (
  <ChartFrame testId={AT_RISK_TEST_ID} legend={AT_RISK_LEGEND}>
    <AreaChart data={[...points]} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={BORDER} />
      <XAxis dataKey="date" tickFormatter={formatTrendDay} {...xAxisProps} />
      <YAxis tickFormatter={compactMoney} width={72} {...yAxisProps} />
      <Tooltip
        cursor={{ stroke: BORDER }}
        content={tooltipFor<RevenueTrendPoint>(AT_RISK_TEST_ID, point => ({
          title: formatTrendDay(point.date),
          lines: [
            { label: 'Past due', value: money(point.pastDueMrr), color: WARN, opacity: 0.6 },
            { label: 'Canceling', value: money(point.cancelingMrr), color: WARN },
          ],
        }))}
      />
      <Area
        dataKey="pastDueMrr"
        name="Past due"
        type="monotone"
        fill={WARN}
        fillOpacity={0.3}
        stroke={WARN}
        strokeWidth={2}
        dot={points.length === 1}
        isAnimationActive={false}
      />
      <Area
        dataKey="cancelingMrr"
        name="Canceling"
        type="monotone"
        fill="none"
        stroke={WARN}
        strokeWidth={2}
        strokeDasharray="4 3"
        dot={points.length === 1}
        isAnimationActive={false}
      />
    </AreaChart>
  </ChartFrame>
);
