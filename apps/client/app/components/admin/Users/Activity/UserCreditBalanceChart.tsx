import React, { useMemo } from 'react';
import { Alert, Box, CircularProgress, Stack, Typography, useTheme } from '@mui/joy';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UserCreditAdjustmentMarker, UserCreditHistory } from '@bike4mind/common';
import { useUserCreditHistory } from '@client/app/hooks/data/adminUserActivity';

type ChartPoint = {
  day: string;
  balance: number;
  /** Set only on days with an admin adjustment, so the marker series draws a dot there and nowhere else. */
  markerBalance?: number;
  adjustments: UserCreditAdjustmentMarker[];
};

const formatCredits = (value: number): string => value.toLocaleString();
const formatSigned = (value: number): string => `${value > 0 ? '+' : ''}${value.toLocaleString()}`;

export const buildChartPoints = (history: UserCreditHistory): ChartPoint[] => {
  const adjustmentsByDay = new Map<string, UserCreditAdjustmentMarker[]>();
  for (const adjustment of history.adjustments) {
    const day = adjustment.occurredAt.slice(0, 10);
    adjustmentsByDay.set(day, [...(adjustmentsByDay.get(day) ?? []), adjustment]);
  }
  return history.points.map(point => {
    const adjustments = adjustmentsByDay.get(point.day) ?? [];
    return { ...point, adjustments, markerBalance: adjustments.length > 0 ? point.balance : undefined };
  });
};

/** Clamped to the chart's first day: the shaded span may begin before the window does. */
const shadedRange = (points: ChartPoint[], unreliableBefore: string | null): { x1: string; x2: string } | null => {
  const first = points[0];
  if (!unreliableBefore || !first) return null;
  return { x1: first.day, x2: unreliableBefore.slice(0, 10) };
};

type TooltipProps = { active?: boolean; payload?: Array<{ payload: ChartPoint }> };

const BalanceTooltip: React.FC<TooltipProps> = ({ active, payload }) => {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <Box
      sx={{
        bgcolor: 'background.surface',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'sm',
        p: 1,
        maxWidth: 280,
      }}
    >
      <Typography level="body-xs">{point.day}</Typography>
      <Typography level="body-sm" fontWeight="lg">
        {formatCredits(point.balance)} credits
      </Typography>
      {point.adjustments.map(adjustment => (
        <Box key={adjustment.transactionId} sx={{ mt: 0.5 }}>
          <Typography level="body-xs" fontWeight="lg">
            {formatSigned(adjustment.credits)} by {adjustment.actorName}
          </Typography>
          {adjustment.reason && <Typography level="body-xs">{adjustment.reason}</Typography>}
        </Box>
      ))}
    </Box>
  );
};

const unreliableCaption = (unreliableBefore: string, points: ChartPoint[]): string => {
  const lastDay = points[points.length - 1]?.day;
  if (lastDay !== undefined && unreliableBefore.slice(0, 10) >= lastDay) {
    return 'Admin credit changes were not always written to the ledger, so this balance history may be incomplete.';
  }
  return `Before ${unreliableBefore.slice(0, 10)}, admin credit changes were not always written to the ledger, so the shaded part may be incomplete.`;
};

export const UserCreditBalanceChart: React.FC<{ userId: string }> = ({ userId }) => {
  const theme = useTheme();
  const { data: history, isLoading, isError } = useUserCreditHistory(userId);
  const points = useMemo(() => (history ? buildChartPoints(history) : []), [history]);

  if (isLoading) return <CircularProgress size="sm" />;
  if (isError || !history) {
    return (
      <Alert color="danger" variant="soft" data-testid="user-credit-chart-error">
        Could not load the credit history.
      </Alert>
    );
  }

  const shaded = shadedRange(points, history.unreliableBefore);
  return (
    <Stack spacing={1} data-testid="user-credit-chart">
      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
        <Typography level="title-sm">Credit balance, last {history.windowDays} days</Typography>
        <Typography level="body-sm">Now: {formatCredits(history.currentBalance)}</Typography>
      </Stack>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
          <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis tick={{ fontSize: 11 }} width={64} />
          {shaded && (
            <ReferenceArea
              x1={shaded.x1}
              x2={shaded.x2}
              fill={theme.palette.warning.softBg}
              fillOpacity={0.6}
              ifOverflow="hidden"
            />
          )}
          <Tooltip content={<BalanceTooltip />} />
          <Line
            type="stepAfter"
            dataKey="balance"
            stroke={theme.palette.primary[500]}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="markerBalance"
            stroke="none"
            dot={{ r: 5, fill: theme.palette.warning[500], stroke: theme.palette.background.surface }}
            activeDot={{ r: 7 }}
            connectNulls={false}
            isAnimationActive={false}
            legendType="none"
          />
        </ComposedChart>
      </ResponsiveContainer>
      {history.unreliableBefore && (
        <Typography level="body-xs" color="warning" data-testid="user-credit-chart-unreliable-note">
          {unreliableCaption(history.unreliableBefore, points)}
        </Typography>
      )}
      {history.adjustmentsTruncated && (
        <Typography level="body-xs" data-testid="user-credit-chart-truncated-note">
          Only the latest {history.adjustments.length} admin adjustments are marked.
        </Typography>
      )}
    </Stack>
  );
};
