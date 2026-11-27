import { Box, Button, Typography } from '@mui/joy';
import type { SpendData } from '@bike4mind/common';
import type { AdminRevenueTrendResponse } from '@bike4mind/server-utils/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@bike4mind/server-utils/app/utils/adminSubscriptionsFilter';
import { formatAdminActionCount } from '@bike4mind/server-utils/app/components/admin/adminActionCounts';
import { useAdminActionCounts } from '@client/app/hooks/data/adminActionCounts';
import { useSecurityIncidentSignals } from '@client/app/hooks/data/admin';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { SectionCard, formatMoney } from '../shared';
import { formatCount } from '../Analytics/analyticsFormat';
import { AdminTab } from '../adminSidebarConfig';
import { RANGE_DAYS, spendKpi, trendWindow, type DashboardRange } from './dashboardRange';

type QueryState<T> = { data: T | undefined; isLoading: boolean; isError: boolean; refetch: () => unknown };
type Tone = 'neutral' | 'success' | 'warning' | 'danger';

/** Above 2% of LLM calls failing, the error rate is shown as a warning. */
const ERROR_RATE_WARNING = 0.02;

function Cell({
  label,
  value,
  detail,
  tone = 'neutral',
  testId,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
  testId: string;
}) {
  return (
    <Box data-testid={testId} sx={{ bgcolor: 'admin.hover', borderRadius: 'md', px: 1.5, py: 1.25, minWidth: 0 }}>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        {label}
      </Typography>
      <Typography
        level="title-lg"
        color={tone === 'neutral' ? undefined : tone}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Typography>
      {detail && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {detail}
        </Typography>
      )}
    </Box>
  );
}

const cellGridSx = { display: 'grid', gap: 1, p: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };

const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const formatRate = (rate: number) => `${(rate * 100).toFixed(1)}%`;

function alarmCell(signals: ReturnType<typeof useSecurityIncidentSignals>) {
  if (signals.isLoading) return { value: '\u2026' };
  if (signals.isError || !signals.data || signals.data.alarms.total === null || signals.data.alarms.error)
    return { value: '-', detail: 'Could not read alarms', tone: 'warning' as const };
  const firing = signals.data.alarms.inAlarm;
  return firing.length === 0
    ? { value: '0 firing', tone: 'success' as const }
    : { value: `${firing.length} firing`, detail: firing[0].name, tone: 'danger' as const };
}

/** Whether the platform is healthy right now: alarms, LLM failures and latency, and stuck messages. */
export function PlatformHealthCard({
  range,
  spend,
  onNavigate,
}: {
  range: DashboardRange;
  spend: QueryState<SpendData>;
  onNavigate: (tab: AdminTab) => void;
}) {
  const impersonating = useAccessToken(state => state.impersonating);
  const signals = useSecurityIncidentSignals('24h');
  const counts = useAdminActionCounts({ enabled: !impersonating });
  const errorRate = spendKpi(spend.data, 'errorRate');
  const p50 = spendKpi(spend.data, 'p50Latency');
  const p95 = spendKpi(spend.data, 'p95Latency');
  const deadLetters = counts.data?.deadLetters;
  const alarms = alarmCell(signals);
  const spendValue = (render: () => string) => (spend.isLoading ? '\u2026' : spend.isError ? '-' : render());
  const rangeLabel = `last ${RANGE_DAYS[range]} days`;

  return (
    <SectionCard
      title="Platform health"
      body="custom"
      data-testid="admin-dashboard-health"
      action={
        <Button
          size="sm"
          variant="plain"
          onClick={() => onNavigate(AdminTab.SystemHealth)}
          aria-label="Open System health"
        >
          Open
        </Button>
      }
    >
      <Box sx={cellGridSx}>
        <Cell label="CloudWatch alarms" testId="admin-dashboard-health-alarms" {...alarms} />
        <Cell
          label="LLM error rate"
          value={spendValue(() => formatRate(errorRate?.value ?? 0))}
          detail={errorRate ? `was ${formatRate(errorRate.priorValue)}` : rangeLabel}
          tone={errorRate && errorRate.value > ERROR_RATE_WARNING ? 'warning' : 'neutral'}
          testId="admin-dashboard-health-errors"
        />
        <Cell
          label="p95 response time"
          value={spendValue(() => formatSeconds(p95?.value ?? 0))}
          detail={p50 ? `p50 ${formatSeconds(p50.value)}` : rangeLabel}
          testId="admin-dashboard-health-latency"
        />
        <Cell
          label="Dead-letter messages"
          value={deadLetters == null ? '-' : formatAdminActionCount(deadLetters)}
          tone={deadLetters ? 'warning' : 'neutral'}
          testId="admin-dashboard-health-dlq"
        />
      </Box>
    </SectionCard>
  );
}

/** Sums the daily snapshots over the range; `newMrr` and `churnedMrr` each cover one day. Null when the data does not span the range. */
export function revenueMovement(revenue: AdminRevenueTrendResponse | undefined, days: number) {
  if (!revenue?.stripeConfigured || revenue.trend.length === 0) return null;
  const { latest, baseline, window: snapshots } = trendWindow(revenue.trend, days);
  if (!baseline) return null;
  const sum = (pick: (point: (typeof snapshots)[number]) => number) =>
    snapshots.reduce((total, p) => total + pick(p), 0);
  return {
    newMrr: sum(point => point.newMrr),
    churnedMrr: sum(point => point.churnedMrr),
    pastDueMrr: latest.pastDueMrr,
    payingCount: latest.payingCount,
    payingChange: latest.payingCount - baseline.payingCount,
  };
}

export function RevenueMovementCard({
  range,
  revenue,
  onNavigate,
}: {
  range: DashboardRange;
  revenue: QueryState<AdminRevenueTrendResponse>;
  onNavigate: (tab: AdminTab) => void;
}) {
  const movement = revenueMovement(revenue.data, RANGE_DAYS[range]);
  const money = (minor: number) => formatMoney(minor, MRR_CURRENCY, { compact: true });
  const placeholder = revenue.isLoading ? '\u2026' : '-';
  const change = movement?.payingChange ?? 0;

  return (
    <SectionCard
      title="Revenue movement"
      body="custom"
      data-testid="admin-dashboard-revenue"
      action={
        <Button size="sm" variant="plain" onClick={() => onNavigate(AdminTab.Revenue)} aria-label="Open Revenue">
          Open
        </Button>
      }
    >
      {revenue.data && !revenue.data.stripeConfigured ? (
        <Typography level="body-sm" sx={{ p: 2 }}>
          Stripe is not configured on this environment.
        </Typography>
      ) : revenue.isError ? (
        <Typography level="body-sm" color="warning" sx={{ p: 2 }}>
          Revenue could not be loaded.
        </Typography>
      ) : (
        <Box sx={cellGridSx}>
          <Cell
            label="New MRR"
            value={movement ? `+${money(movement.newMrr)}` : placeholder}
            tone="success"
            testId="admin-dashboard-revenue-new"
          />
          <Cell
            label="Churned MRR"
            value={movement ? `-${money(movement.churnedMrr)}` : placeholder}
            tone={movement?.churnedMrr ? 'danger' : 'neutral'}
            testId="admin-dashboard-revenue-churned"
          />
          <Cell
            label="Past due"
            value={movement ? money(movement.pastDueMrr) : placeholder}
            tone={movement?.pastDueMrr ? 'warning' : 'neutral'}
            testId="admin-dashboard-revenue-past-due"
          />
          <Cell
            label="Paying accounts"
            value={movement ? formatCount(movement.payingCount) : placeholder}
            detail={movement ? `${change >= 0 ? '+' : ''}${change} in ${RANGE_DAYS[range]} days` : undefined}
            testId="admin-dashboard-revenue-paying"
          />
        </Box>
      )}
    </SectionCard>
  );
}
