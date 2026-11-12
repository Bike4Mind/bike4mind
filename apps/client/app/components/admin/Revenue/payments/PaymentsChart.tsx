import React from 'react';
import { Box, Stack } from '@mui/joy';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney } from '../../shared/formatMoney';
import {
  ACCENT,
  BORDER,
  ChartLegend,
  ChartTooltipBox,
  xAxisProps,
  yAxisProps,
  type ChartLegendItem,
} from '../chartParts';

export type PaymentsChartPoint = { date: string; label: string; subscription: number; creditPurchase: number };

const TEST_ID = 'admin-payments-chart';
// Two categories that are not statuses: one hue stepped down (DESIGN_GUIDE "Data visualization").
const CREDIT_OPACITY = 0.45;

const LEGEND: ChartLegendItem[] = [
  { label: 'Subscriptions', color: ACCENT },
  { label: 'Credit purchases', color: ACCENT, opacity: CREDIT_OPACITY },
];

type TooltipProps = { currency: string; active?: boolean; payload?: Array<{ payload: PaymentsChartPoint }> };

// recharts clones `content` with `active` and `payload`, so it is passed as an element.
function PaymentsTooltip({ currency, active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const money = (amount: number) => formatMoney(amount, currency);
  return (
    <ChartTooltipBox
      testId={TEST_ID}
      title={point.label}
      lines={[
        { label: 'Subscriptions', value: money(point.subscription), color: ACCENT },
        { label: 'Credit purchases', value: money(point.creditPurchase), color: ACCENT, opacity: CREDIT_OPACITY },
        { label: 'Total', value: money(point.subscription + point.creditPurchase) },
      ]}
    />
  );
}

/** Stacked bars of subscription payments and credit purchases per bucket, in one currency. */
export const PaymentsChart: React.FC<{ points: readonly PaymentsChartPoint[]; currency: string }> = ({
  points,
  currency,
}) => {
  const compactMoney = (amount: number) => formatMoney(amount, currency, { compact: true });
  return (
    <Stack gap={1}>
      <Box data-testid={TEST_ID} sx={{ height: 220, minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[...points]} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={BORDER} />
            <XAxis dataKey="label" {...xAxisProps} />
            <YAxis tickFormatter={compactMoney} width={72} {...yAxisProps} />
            <Tooltip cursor={{ fill: BORDER, fillOpacity: 0.4 }} content={<PaymentsTooltip currency={currency} />} />
            <Bar
              dataKey="subscription"
              name="Subscriptions"
              stackId="payments"
              fill={ACCENT}
              isAnimationActive={false}
            />
            <Bar
              dataKey="creditPurchase"
              name="Credit purchases"
              stackId="payments"
              fill={ACCENT}
              fillOpacity={CREDIT_OPACITY}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </Box>
      <ChartLegend testId={TEST_ID} items={LEGEND} />
    </Stack>
  );
};
