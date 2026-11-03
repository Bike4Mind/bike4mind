import type { ReactNode } from 'react';
import { Alert, Box, Button, Skeleton, Stack, Typography } from '@mui/joy';
import type { UseQueryResult } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useSecurityIncidentSignals, useSecurityIncidentState, useSignupAnomaly } from '@client/app/hooks/data/admin';
import { SIGNUP_TIMESERIES_RANGE_LABELS, type SignupTimeseriesRange } from '@client/app/utils/signupSignals';
import { AnalyticsTermHelp } from '../EventMetrics/components/AnalyticsTermHelp';
import { SignupChart } from '../Signups/SignupChart';
import { useSignupTimeseries } from '../Signups/useSignupTimeseries';
import { AnomalyBanner } from '../Users/AnomalyBanner';
import { AdminTab } from '../adminSidebarConfig';
import { adminTabToSlug } from '../adminTabSlugs';
import { useSecurityDashboardSearch } from './useSecurityDashboardSearch';
import {
  ErrorState,
  Fact,
  formatMoney,
  InlineBar,
  RelativeTime,
  SectionCard,
  SegmentedControl,
  StatStrip,
  StatTile,
  StatusChip,
  UpdatingBar,
  type SegmentedOption,
} from '../shared';
import {
  INCIDENT_RANGES,
  type IncidentBlockListAction,
  type IncidentMetricTotals,
  type IncidentQueues,
  type IncidentRange,
  type IncidentSignals,
  type IncidentState,
  type PaymentWindow,
} from './incidentTypes';

const DASH = '\u2014';
const SIGNALS_DOWN = 'Could not load live signals.';
const STATE_DOWN = 'Could not load defenses, queues and payments.';

const RANGE_OPTIONS: readonly SegmentedOption<IncidentRange>[] = INCIDENT_RANGES.map(range => ({
  value: range,
  label: range,
}));
const RANGE_PHRASES: Record<IncidentRange, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};
// The signup chart has no 1h range; the last day shows that hour in context.
const CHART_RANGE: Record<IncidentRange, SignupTimeseriesRange> = { '1h': '24h', '24h': '24h', '7d': '7d' };
const CHART_HEIGHT = 240;

const BLOCK_LIST_CHIPS: Record<IncidentBlockListAction, { tone: 'bad' | 'warn' | 'neutral'; label: string }> = {
  block: { tone: 'bad', label: 'Block' },
  count: { tone: 'warn', label: 'Count' },
  other: { tone: 'neutral', label: 'Other' },
};

const QUEUES: ReadonlyArray<{
  key: Exclude<keyof IncidentQueues, 'error'>;
  id: string;
  label: string;
  tab: AdminTab;
}> = [
  { key: 'riskReviewsPending', id: 'risk-review', label: 'Risk review', tab: AdminTab.SignupRiskReview },
  { key: 'heldGrants', id: 'held-grants', label: 'Held grants (budget)', tab: AdminTab.HeldSignupGrants },
  { key: 'domainHoldsPending', id: 'domain-holds', label: 'Signup domain holds', tab: AdminTab.SignupDomainHolds },
];

const PAYMENT_ROWS: ReadonlyArray<{ key: keyof PaymentWindow; label: string }> = [
  { key: 'attempts', label: 'Attempts' },
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
  { key: 'radarBlocked', label: 'Radar blocked' },
  { key: 'elevatedRisk', label: 'Elevated risk' },
  { key: 'hostingNetwork', label: 'Hosting network' },
  { key: 'distinctCards', label: 'Distinct cards' },
];

const MORE_SIGNALS: ReadonlyArray<{
  key: 'signupCodeSends' | 'apiKeyCreations' | 'oauthSignupsRefused' | 'turnstileMisconfigured';
  id: string;
  label: string;
  help: string;
}> = [
  {
    key: 'signupCodeSends',
    id: 'signup-code-sends',
    label: 'Signup code sends',
    help: 'Verification codes sent to people signing up.',
  },
  {
    key: 'apiKeyCreations',
    id: 'api-key-creations',
    label: 'API key creations',
    help: 'API keys created by any account.',
  },
  {
    key: 'oauthSignupsRefused',
    id: 'oauth-signups-refused',
    label: 'OAuth signups refused',
    help: 'Signups through an outside sign-in provider that were turned away.',
  },
  {
    key: 'turnstileMisconfigured',
    id: 'turnstile-misconfigured',
    label: 'Turnstile misconfigured',
    help: 'Challenge checks that could not run because Turnstile is not set up correctly.',
  },
];

/** One hook's state, reduced to what a section needs to pick skeleton, value or failure. */
type Source<T> = { data: T | undefined; loading: boolean; down: boolean };

function sourceOf<T>(query: UseQueryResult<T>): Source<T> {
  return { data: query.data, loading: !query.data && !query.isError, down: !query.data && query.isError };
}

const formatCount = (value: number | null | undefined) =>
  value === null || value === undefined ? DASH : value.toLocaleString();

function MutedDash() {
  return (
    <Box component="span" sx={{ color: 'admin.inkMuted' }}>
      {DASH}
    </Box>
  );
}

function HelpText({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
      {children}
    </Typography>
  );
}

/** A value that could not be read: a muted dash with the reason under it. */
function Unavailable({ error, testId }: { error?: string; testId?: string }) {
  return (
    <Stack gap={0.25} data-testid={testId}>
      <MutedDash />
      {error && <HelpText>{error}</HelpText>}
    </Stack>
  );
}

/** A firewall section on a stage with no firewall: nothing to read, which is not a failure. */
const isNotConfigured = (section: object | undefined): boolean =>
  section !== undefined && 'notConfigured' in section && section.notConfigured === true;

const NO_FIREWALL = 'No firewall on this stage';

function NoFirewall({ testId }: { testId?: string }) {
  return (
    <Box component="span" sx={{ color: 'admin.inkMuted' }} data-testid={testId}>
      {NO_FIREWALL}
    </Box>
  );
}

function Chips({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap" alignItems="center">
      {children}
    </Stack>
  );
}

const FactSkeleton = () => <Skeleton variant="text" level="body-sm" width="10ch" />;

function CardSkeleton({ title, testId }: { title: string; testId: string }) {
  return (
    <SectionCard title={title} body="custom" data-testid={testId}>
      <Stack gap={1} sx={{ px: 2, py: 1.75 }} data-testid={`${testId}-skeleton`}>
        {[0, 1, 2].map(index => (
          <Skeleton key={index} variant="text" level="body-sm" />
        ))}
      </Stack>
    </SectionCard>
  );
}

function CardError({
  title,
  testId,
  message,
  onRetry,
}: {
  title: string;
  testId: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <SectionCard title={title} body="custom" data-testid={testId}>
      <ErrorState message={message} onRetry={onRetry} />
    </SectionCard>
  );
}

function TileValue({
  loading,
  value,
  testId,
}: {
  loading: boolean;
  value: string | number | null | undefined;
  testId: string;
}) {
  if (loading) return <Skeleton variant="text" level="h3" width="4ch" data-testid="security-incident-tile-skeleton" />;
  return (
    <Box component="span" data-testid={testId}>
      {value === null || value === undefined ? (
        <MutedDash />
      ) : typeof value === 'number' ? (
        value.toLocaleString()
      ) : (
        value
      )}
    </Box>
  );
}

function IncidentTiles({ signals, state }: { signals: Source<IncidentSignals>; state: Source<IncidentState> }) {
  const metrics = signals.data?.metrics;
  const waf = signals.data?.waf;
  const alarms = signals.data?.alarms;
  const payments = state.data?.payments;
  const last24h = payments?.last24h;
  const signalsError = (sectionError?: string) => (signals.down ? SIGNALS_DOWN : (sectionError ?? 'Not available'));
  const stateError = (sectionError?: string) => (state.down ? STATE_DOWN : (sectionError ?? 'Not available'));
  // Shown only while the value itself is known; otherwise the comparison line carries the reason.
  const comparison = (loading: boolean, known: boolean, text: string, failure: string) =>
    loading ? undefined : known ? text : failure;

  const signups = metrics?.successfulSignups ?? null;
  const spend = metrics?.youngAccountSpendUsd ?? null;
  const blocked = waf?.blocked ?? null;
  const wafTotal =
    waf && waf.allowed !== null && waf.blocked !== null && waf.counted !== null
      ? waf.allowed + waf.blocked + waf.counted
      : null;
  const alarmTotal = alarms?.total ?? null;
  const wafNotConfigured = isNotConfigured(waf);

  return (
    <StatStrip aria-label="Incident signals">
      <StatTile
        label="Signups"
        help={
          <AnalyticsTermHelp
            term="Signups"
            description="Successful signups counted by the hourly census."
            testId="security-incident-signups-help-btn"
          />
        }
        value={<TileValue loading={signals.loading} value={signups} testId="security-incident-signups-value" />}
        comparison={comparison(
          signals.loading,
          signups !== null,
          `Full grants ${formatCount(metrics?.fullGrants)}`,
          signalsError(metrics?.error)
        )}
      />
      <StatTile
        label="Young-account spend"
        help={
          <AnalyticsTermHelp
            term="Young-account spend"
            description="Spend by accounts younger than seven days, estimated from our price table."
            testId="security-incident-spend-help-btn"
          />
        }
        value={
          <TileValue
            loading={signals.loading}
            // The metric is whole dollars; formatMoney takes minor units.
            value={spend === null ? null : formatMoney(Math.round(spend * 100), 'usd', { compact: true })}
            testId="security-incident-spend-value"
          />
        }
        comparison={comparison(signals.loading, spend !== null, 'Ledger estimate', signalsError(metrics?.error))}
      />
      <StatTile
        label="WAF blocked"
        help={
          <AnalyticsTermHelp
            term="WAF blocked"
            description="Requests the firewall blocked."
            testId="security-incident-waf-help-btn"
          />
        }
        value={<TileValue loading={signals.loading} value={blocked} testId="security-incident-waf-value" />}
        comparison={comparison(
          signals.loading,
          blocked !== null,
          wafTotal === null ? (waf?.error ?? `of ${DASH} requests`) : `of ${wafTotal.toLocaleString()} requests`,
          wafNotConfigured ? NO_FIREWALL : signalsError(waf?.error)
        )}
      />
      <StatTile
        label="Alarms firing"
        help={
          <AnalyticsTermHelp
            term="Alarms firing"
            description="CloudWatch alarms in ALARM state."
            testId="security-incident-alarms-help-btn"
          />
        }
        value={
          <TileValue
            loading={signals.loading}
            value={alarmTotal === null ? null : (alarms?.inAlarm.length ?? null)}
            testId="security-incident-alarms-value"
          />
        }
        comparison={comparison(
          signals.loading,
          alarmTotal !== null,
          `of ${formatCount(alarmTotal)} alarms`,
          signalsError(alarms?.error)
        )}
      />
      <StatTile
        label="Payments 24h"
        help={
          <AnalyticsTermHelp
            term="Payments 24h"
            description="Card payments started."
            testId="security-incident-payments-help-btn"
          />
        }
        value={
          <TileValue
            loading={state.loading}
            value={last24h?.attempts ?? null}
            testId="security-incident-payments-value"
          />
        }
        comparison={comparison(
          state.loading,
          Boolean(last24h),
          `${formatCount(last24h?.radarBlocked)} Radar blocked, ${formatCount(last24h?.elevatedRisk)} elevated risk`,
          stateError(payments?.error)
        )}
      />
    </StatStrip>
  );
}

function DefensesCard({ signals, state }: { signals: Source<IncidentSignals>; state: Source<IncidentState> }) {
  const testId = 'security-incident-defenses-card';
  if (signals.loading && state.loading) return <CardSkeleton title="Defenses" testId={testId} />;

  const defenses = state.data?.defenses;
  const defensesError = state.down ? STATE_DOWN : defenses?.error;
  const blockLists = signals.data?.blockLists;
  const blockListsError = signals.down ? SIGNALS_DOWN : blockLists?.error;
  const noFirewall = isNotConfigured(blockLists);
  const turnstile = defenses?.turnstile;
  const grantBudget = defenses?.grantBudget;
  const spendCapDays = defenses?.newAccountSpendCapDays ?? null;
  const paymentRisk = defenses?.paymentRisk;
  const blocker = blockLists?.blockerActiveEntries;

  const stateFact = (render: () => ReactNode) => (state.loading ? <FactSkeleton /> : render());
  const signalsFact = (render: () => ReactNode) => (signals.loading ? <FactSkeleton /> : render());

  return (
    <SectionCard title="Defenses" data-testid={testId}>
      <Fact label="Turnstile" data-testid="security-incident-turnstile">
        {stateFact(() =>
          turnstile ? (
            <Chips>
              <StatusChip
                tone={turnstile.enabled ? (turnstile.failClosed ? 'good' : 'info') : 'neutral'}
                label={turnstile.enabled ? (turnstile.failClosed ? 'On, fail closed' : 'On') : 'Off'}
                data-testid="security-incident-turnstile-chip"
              />
              {turnstile.enabled && turnstile.secretConfigured === false && (
                <StatusChip tone="warn" label="Secret missing" data-testid="security-incident-turnstile-secret-chip" />
              )}
              {turnstile.enabled && turnstile.secretConfigured === null && (
                <StatusChip
                  tone="neutral"
                  label="Secret: Unknown"
                  data-testid="security-incident-turnstile-secret-chip"
                />
              )}
            </Chips>
          ) : (
            <Unavailable error={defensesError} />
          )
        )}
      </Fact>
      {blockLists && blockLists.lists.length > 0 ? (
        blockLists.lists.map((list, index) => (
          <Fact key={`${list.name}-${index}`} label={list.name} data-testid={`security-incident-block-list-${index}`}>
            <Chips>
              <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums', mr: 0.5 }}>
                {list.entries.toLocaleString()} {list.entries === 1 ? 'entry' : 'entries'}
              </Box>
              <StatusChip
                tone={BLOCK_LIST_CHIPS[list.action].tone}
                label={BLOCK_LIST_CHIPS[list.action].label}
                data-testid={`security-incident-block-list-${index}-chip`}
              />
            </Chips>
          </Fact>
        ))
      ) : (
        <Fact label="Block lists" data-testid="security-incident-block-lists">
          {signalsFact(() =>
            noFirewall ? (
              <NoFirewall testId="security-incident-block-lists-none" />
            ) : blockLists && !blockListsError ? (
              <StatusChip tone="neutral" label="None" />
            ) : (
              <Unavailable error={blockListsError} />
            )
          )}
        </Fact>
      )}
      <Fact label="Runtime blocker" data-testid="security-incident-blocker">
        {signalsFact(() =>
          blocker ? (
            <Stack direction="row" gap={1} flexWrap="wrap" alignItems="baseline">
              <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {blocker.value.toLocaleString()} active entries
              </Box>
              <RelativeTime at={blocker.at} />
            </Stack>
          ) : noFirewall ? (
            <NoFirewall testId="security-incident-blocker-none" />
          ) : (
            <Unavailable error={blockListsError} />
          )
        )}
      </Fact>
      <Fact label="Grant budget" data-testid="security-incident-grant-budget">
        {stateFact(() =>
          grantBudget ? (
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {grantBudget.spentToday.toLocaleString()} of {grantBudget.limit.toLocaleString()} credits
              </Box>
              <InlineBar value={grantBudget.spentToday} max={grantBudget.limit} />
            </Stack>
          ) : defensesError ? (
            <Unavailable error={defensesError} />
          ) : (
            <StatusChip tone="neutral" label="Unmetered" />
          )
        )}
      </Fact>
      <Fact label="New-account spend cap" data-testid="security-incident-spend-cap">
        {stateFact(() =>
          spendCapDays !== null ? (
            `${spendCapDays.toLocaleString()} ${spendCapDays === 1 ? 'day' : 'days'}`
          ) : defensesError ? (
            <Unavailable error={defensesError} />
          ) : (
            <StatusChip tone="neutral" label="Off" />
          )
        )}
      </Fact>
      <Fact label="Payment risk" data-testid="security-incident-payment-risk">
        {stateFact(() =>
          paymentRisk ? (
            <Stack gap={0.75}>
              <Chips>
                {(
                  [
                    ['Alerts', paymentRisk.alertsEnabled, 'alerts'],
                    ['Auto-refund', paymentRisk.autoRefundEnabled, 'auto-refund'],
                    ['Linked accounts', paymentRisk.linkedAccountActions, 'linked-accounts'],
                  ] as const
                ).map(([label, on, id]) => (
                  <StatusChip
                    key={id}
                    tone={on ? 'good' : 'neutral'}
                    label={`${label} ${on ? 'on' : 'off'}`}
                    data-testid={`security-incident-payment-${id}-chip`}
                  />
                ))}
              </Chips>
              {paymentRisk.checkoutMaxBlockedAttempts !== null && (
                <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
                  Checkout block after {paymentRisk.checkoutMaxBlockedAttempts.toLocaleString()} attempts
                </Typography>
              )}
            </Stack>
          ) : (
            <Unavailable error={defensesError} />
          )
        )}
      </Fact>
    </SectionCard>
  );
}

function QueuesCard({ state, onRetry }: { state: Source<IncidentState>; onRetry: () => void }) {
  const navigate = useNavigate();
  const testId = 'security-incident-queues-card';
  if (state.loading) return <CardSkeleton title="Queues" testId={testId} />;
  if (!state.data) return <CardError title="Queues" testId={testId} message={STATE_DOWN} onRetry={onRetry} />;
  const queues = state.data.queues;
  return (
    <SectionCard title="Queues" data-testid={testId}>
      {QUEUES.map(queue => {
        const value = queues[queue.key];
        return (
          <Fact key={queue.id} label={queue.label}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
              {value === null ? (
                <Unavailable error={queues.error} />
              ) : (
                <Box
                  component="span"
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                  data-testid={`security-incident-queue-${queue.id}-count`}
                >
                  {value.toLocaleString()}
                </Box>
              )}
              <Button
                size="sm"
                variant="plain"
                aria-label={`Open ${queue.label}`}
                onClick={() => void navigate({ to: '/admin', search: { tab: adminTabToSlug(queue.tab) } })}
                data-testid={`security-incident-queue-${queue.id}-btn`}
              >
                Open
              </Button>
            </Stack>
          </Fact>
        );
      })}
    </SectionCard>
  );
}

function AlarmsCard({ signals, onRetry }: { signals: Source<IncidentSignals>; onRetry: () => void }) {
  const testId = 'security-incident-alarms-card';
  if (signals.loading) return <CardSkeleton title="Alarms" testId={testId} />;
  const alarms = signals.data?.alarms;
  if (!alarms || alarms.total === null) {
    const message = signals.down ? SIGNALS_DOWN : (alarms?.error ?? 'Could not read alarms.');
    return <CardError title="Alarms" testId={testId} message={message} onRetry={onRetry} />;
  }
  return (
    <SectionCard
      title="Alarms"
      body="custom"
      data-testid={testId}
      action={
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {alarms.inAlarm.length.toLocaleString()} of {alarms.total.toLocaleString()} firing
        </Typography>
      }
    >
      {alarms.inAlarm.length === 0 ? (
        <Typography
          role="status"
          level="body-sm"
          sx={{ px: 2, py: 1.75, color: 'admin.inkMuted' }}
          data-testid="security-incident-alarms-empty"
        >
          No alarms firing
        </Typography>
      ) : (
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {alarms.inAlarm.map(alarm => (
            <Stack
              component="li"
              key={`${alarm.name}-${alarm.since}`}
              direction="row"
              justifyContent="space-between"
              alignItems="baseline"
              gap={1.5}
              sx={{
                px: 2,
                py: 1.25,
                borderTop: '1px solid',
                borderColor: 'admin.border',
                '&:first-of-type': { borderTop: 0 },
              }}
              data-testid="security-incident-alarm-row"
            >
              <Typography level="body-sm" sx={{ color: 'admin.ink', minWidth: 0, overflowWrap: 'anywhere' }}>
                {alarm.name}
              </Typography>
              <RelativeTime at={alarm.since} />
            </Stack>
          ))}
        </Box>
      )}
    </SectionCard>
  );
}

const paymentCellSx = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'admin.ink' } as const;
const paymentHeaderSx = { typography: 'body-xs', fontWeight: 500, color: 'admin.inkMuted' } as const;

function PaymentCell({
  values,
  field,
  testId,
}: {
  values: PaymentWindow | null;
  field: keyof PaymentWindow;
  testId: string;
}) {
  return (
    <Box role="cell" sx={paymentCellSx} data-testid={testId}>
      {values ? values[field].toLocaleString() : <MutedDash />}
    </Box>
  );
}

function PaymentsCard({ state, onRetry }: { state: Source<IncidentState>; onRetry: () => void }) {
  const testId = 'security-incident-payments-card';
  if (state.loading) return <CardSkeleton title="Payments" testId={testId} />;
  if (!state.data) return <CardError title="Payments" testId={testId} message={STATE_DOWN} onRetry={onRetry} />;
  const payments = state.data.payments;
  return (
    <SectionCard title="Payments" body="custom" data-testid={testId}>
      <Box
        role="table"
        aria-label="Card payments"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto auto',
          columnGap: 3,
          rowGap: 1,
          px: 2,
          py: 1.75,
          typography: 'body-sm',
        }}
      >
        <Box role="row" sx={{ display: 'contents' }}>
          <Box role="columnheader" sx={paymentHeaderSx}>
            Metric
          </Box>
          <Box role="columnheader" sx={{ ...paymentHeaderSx, textAlign: 'right' }}>
            Last 24 h
          </Box>
          <Box role="columnheader" sx={{ ...paymentHeaderSx, textAlign: 'right' }}>
            Last 7 d
          </Box>
        </Box>
        {PAYMENT_ROWS.map(row => (
          <Box role="row" key={row.key} sx={{ display: 'contents' }}>
            <Box role="rowheader" sx={{ color: 'admin.inkMuted' }}>
              {row.label}
            </Box>
            <PaymentCell
              values={payments.last24h}
              field={row.key}
              testId={`security-incident-payments-24h-${row.key}`}
            />
            <PaymentCell values={payments.last7d} field={row.key} testId={`security-incident-payments-7d-${row.key}`} />
          </Box>
        ))}
      </Box>
      {payments.error && (
        <Box sx={{ px: 2, pb: 1.75 }}>
          <HelpText testId="security-incident-payments-error">{payments.error}</HelpText>
        </Box>
      )}
    </SectionCard>
  );
}

function MoreSignalsCard({
  signals,
  range,
  onRetry,
}: {
  signals: Source<IncidentSignals>;
  range: IncidentRange;
  onRetry: () => void;
}) {
  const testId = 'security-incident-more-signals-card';
  if (signals.loading) return <CardSkeleton title="More signals" testId={testId} />;
  if (!signals.data) return <CardError title="More signals" testId={testId} message={SIGNALS_DOWN} onRetry={onRetry} />;
  const metrics: IncidentMetricTotals = signals.data.metrics;
  return (
    <SectionCard
      title="More signals"
      data-testid={testId}
      action={
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {RANGE_PHRASES[range]}
        </Typography>
      }
    >
      {MORE_SIGNALS.map(signal => {
        const value = metrics[signal.key];
        return (
          <Fact key={signal.key} label={signal.label}>
            <Stack gap={0.25}>
              {value === null ? (
                <Unavailable error={metrics.error} />
              ) : (
                <Box
                  component="span"
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                  data-testid={`security-incident-signal-${signal.id}`}
                >
                  {value.toLocaleString()}
                </Box>
              )}
              <HelpText>{signal.help}</HelpText>
            </Stack>
          </Fact>
        );
      })}
    </SectionCard>
  );
}

function SignupsSection({ range }: { range: IncidentRange }) {
  const chartRange = CHART_RANGE[range];
  const query = useSignupTimeseries(chartRange);
  const data = query.data;
  let body: ReactNode;
  if (data) {
    body = (
      <Stack gap={1} sx={{ px: 2, py: 1.75 }}>
        <HelpText testId="security-incident-signups-summary">
          {`${data.totals.total.toLocaleString()} signups: ${data.totals.likelyLegit.toLocaleString()} likely legit, ${data.totals.suspected.toLocaleString()} suspected. The band is the typical range.`}
        </HelpText>
        <SignupChart data={data} showBaseline height={CHART_HEIGHT} testId="security-incident-signup-chart" />
      </Stack>
    );
  } else if (query.isError) {
    body = (
      <ErrorState message="Could not load signups." onRetry={() => void query.refetch()} retrying={query.isFetching} />
    );
  } else {
    body = (
      <Box sx={{ px: 2, py: 1.75 }}>
        <Skeleton variant="rectangular" height={CHART_HEIGHT} data-testid="security-incident-signup-chart-skeleton" />
      </Box>
    );
  }
  return (
    <SectionCard
      title="Signups"
      body="custom"
      data-testid="security-incident-signups-card"
      action={
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {SIGNUP_TIMESERIES_RANGE_LABELS[chartRange]}
        </Typography>
      }
    >
      {body}
    </SectionCard>
  );
}

/**
 * The Security tab's default view: the numbers that say whether signups, spend, the firewall and
 * payments look normal right now, with the defenses and queues an admin acts on next.
 */
export function IncidentView() {
  const { range, setRange } = useSecurityDashboardSearch();
  const navigate = useNavigate();
  const signalsQuery = useSecurityIncidentSignals(range);
  const stateQuery = useSecurityIncidentState();
  const anomaly = useSignupAnomaly();
  const signals = sourceOf(signalsQuery);
  const state = sourceOf(stateQuery);
  const retrySignals = () => void signalsQuery.refetch();
  const retryState = () => void stateQuery.refetch();
  const generatedAt = signals.data?.generatedAt ?? state.data?.generatedAt;
  const refreshing =
    (signalsQuery.isFetching && Boolean(signalsQuery.data)) || (stateQuery.isFetching && Boolean(stateQuery.data));

  return (
    <Stack gap={2.5} data-testid="security-incident-view">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
        gap={1.5}
      >
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
          aria-label="Time range"
          data-testid="security-incident-range"
        />
        {generatedAt && <RelativeTime prefix="As of" at={generatedAt} data-testid="security-incident-as-of" />}
      </Stack>
      <UpdatingBar active={refreshing} testId="security-incident-updating" />
      <AnomalyBanner
        snapshot={anomaly.data}
        onReview={() =>
          void navigate({
            to: '/admin',
            search: { tab: adminTabToSlug(AdminTab.Users), signedUp: 'hour', groupBy: 'emailDomain' },
          })
        }
      />
      {anomaly.isError && <Alert color="warning">Could not check signup anomalies. Refresh to retry.</Alert>}
      <IncidentTiles signals={signals} state={state} />
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 2,
          alignItems: 'start',
        }}
      >
        <DefensesCard signals={signals} state={state} />
        <QueuesCard state={state} onRetry={retryState} />
        <AlarmsCard signals={signals} onRetry={retrySignals} />
        <PaymentsCard state={state} onRetry={retryState} />
        <MoreSignalsCard signals={signals} range={range} onRetry={retrySignals} />
      </Box>
      <SignupsSection range={range} />
    </Stack>
  );
}
