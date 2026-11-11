import React from 'react';
import { Alert, Box, Link, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { CREDITS_PAGE_READ } from '@bike4mind/common';
import { useAdminBillingOverview } from '@client/app/hooks/data/adminBillingOverview';
import {
  BILLING_RANGES,
  BILLING_RANGE_LABELS,
  type BillingActivityItem,
  type BillingCurrencyTotals,
  type BillingLink,
  type BillingOverview as BillingOverviewData,
  type BillingOwnerType,
  type BillingPaymentRecord,
  type BillingRange,
  type BillingUsageAttribution,
} from '@client/app/utils/adminBillingOverview';
import {
  AdminPermissionGate,
  DataTable,
  ErrorState,
  Fact,
  LoadingState,
  RelativeTime,
  SectionCard,
  SegmentedControl,
  StatStrip,
  StatTile,
  StatusChip,
  UpdatingBar,
  formatMoney,
  type DataColumn,
} from '../shared';
import {
  ACTIVITY_KIND_LABELS,
  FUNDING_LABELS,
  PAYMENT_KIND_LABELS,
  STANDING_CHIPS,
  billingLinkHref,
  formatDay,
  subscriptionNextDate,
  windowStartsBefore,
} from './billingOverviewModel';

type BillingOverviewProps = {
  ownerType: BillingOwnerType;
  ownerId: string;
  range: BillingRange;
  onRangeChange: (range: BillingRange) => void;
};

type Loaded<K extends keyof BillingOverviewData> = Extract<BillingOverviewData[K], { status: 'ok' }>;

const creditsFormat = new Intl.NumberFormat('en-US');
const formatCredits = (credits: number) => creditsFormat.format(Math.round(credits));
const signedCredits = (credits: number) => `${credits > 0 ? '+' : ''}${formatCredits(credits)}`;

const RANGE_OPTIONS = BILLING_RANGES.map(value => ({ value, label: BILLING_RANGE_LABELS[value] }));

const Muted: React.FC<{ children: React.ReactNode; 'data-testid'?: string }> = ({ children, ...rest }) => (
  <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }} {...rest}>
    {children}
  </Typography>
);

/** A real link (open in a new tab works) that stays inside the SPA on a plain click. */
const BillingLinkTo: React.FC<{ link: BillingLink; children: React.ReactNode; 'data-testid'?: string }> = ({
  link,
  children,
  'data-testid': testId,
}) => {
  const navigate = useNavigate();
  const href = billingLinkHref(link);
  return (
    <Link
      href={href}
      level="body-sm"
      data-testid={testId}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        void navigate({ href });
      }}
    >
      {children}
    </Link>
  );
};

const Money: React.FC<{ amount: number | null; currency: string | null }> = ({ amount, currency }) => {
  if (amount === null) return <StatusChip tone="neutral" label="No amount" />;
  if (currency === null) {
    return (
      <Typography level="body-sm" component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {creditsFormat.format(amount)}{' '}
        <Box component="span" sx={{ color: 'admin.inkMuted' }}>
          (minor units, currency not recorded)
        </Box>
      </Typography>
    );
  }
  return (
    <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
      {formatMoney(amount, currency)}
    </Box>
  );
};

const Unavailable: React.FC<{ message: string; testId: string }> = ({ message, testId }) => (
  <Box sx={{ p: 2 }}>
    <Alert color="warning" variant="soft" data-testid={testId}>
      {message}
    </Alert>
  </Box>
);

const CoverageNote: React.FC<{ children: React.ReactNode; testId: string }> = ({ children, testId }) => (
  <Typography level="body-xs" sx={{ px: 2, pb: 1.5, color: 'admin.inkMuted' }} data-testid={testId}>
    {children}
  </Typography>
);

const SubscriptionCard: React.FC<{ section: BillingOverviewData['subscription'] }> = ({ section }) => {
  if (section.status !== 'ok') {
    return (
      <SectionCard title="Subscription" body="custom" data-testid="billing-subscription-card">
        <Unavailable message={section.message} testId="billing-subscription-unavailable" />
      </SectionCard>
    );
  }
  const { current, standing } = section;
  const chip = STANDING_CHIPS[standing];
  const next = current ? subscriptionNextDate(current) : null;
  const latest = current ?? section.previous[0] ?? null;
  return (
    <SectionCard
      title="Subscription"
      data-testid="billing-subscription-card"
      action={
        latest ? (
          <BillingLinkTo
            link={{ kind: 'subscription', subscriptionId: latest.id, tab: 'overview' }}
            data-testid="billing-subscription-link"
          >
            Open subscription
          </BillingLinkTo>
        ) : undefined
      }
    >
      <Fact label="Standing" data-testid="billing-subscription-standing">
        <StatusChip tone={chip.tone} label={chip.label} />
      </Fact>
      <Fact label="Plan">{current ? (current.planName ?? 'Unknown plan') : null}</Fact>
      <Fact label="Status">{current?.status.replace(/_/g, ' ')}</Fact>
      {current && current.quantity > 1 && <Fact label="Seats">{current.quantity}</Fact>}
      <Fact label={next?.label ?? 'Renews'} data-testid="billing-subscription-next">
        {next ? formatDay(next.at) : null}
      </Fact>
      {!current && section.previous[0]?.canceledAt && (
        <Fact label="Ended">{formatDay(section.previous[0].canceledAt)}</Fact>
      )}
    </SectionCard>
  );
};

const CreditsCard: React.FC<{ section: BillingOverviewData['credits'] }> = ({ section }) => (
  <SectionCard
    title="Credit balance"
    data-testid="billing-credits-card"
    body={section.status === 'ok' ? 'facts' : 'custom'}
  >
    {section.status !== 'ok' ? (
      <Unavailable message={section.message} testId="billing-credits-unavailable" />
    ) : (
      <>
        <Fact label="Available" data-testid="billing-credits-available">
          {formatCredits(section.available)} credits
        </Fact>
        <Fact label="Held by requests in flight" data-testid="billing-credits-held">
          {section.heldRequests === 0
            ? 'None'
            : `${formatCredits(section.held)} credits (${section.heldRequests} ${section.heldRequests === 1 ? 'request' : 'requests'})`}
        </Fact>
        {(Object.keys(FUNDING_LABELS) as (keyof typeof FUNDING_LABELS)[]).map(source => (
          <Fact key={source} label={FUNDING_LABELS[source]} data-testid={`billing-credits-funding-${source}`}>
            {formatCredits(section.funding[source])}
          </Fact>
        ))}
      </>
    )}
  </SectionCard>
);

const TOTAL_COLUMNS: readonly DataColumn<BillingCurrencyTotals>[] = [
  { id: 'currency', label: 'Currency', render: row => (row.currency ? row.currency.toUpperCase() : 'Not recorded') },
  ...(
    [
      ['creditPurchases', 'Credit purchases'],
      ['subscriptionPayments', 'Subscriptions'],
      ['refunds', 'Refunds'],
      ['disputes', 'Disputes'],
    ] as const
  ).map(([key, label]): DataColumn<BillingCurrencyTotals> => ({
    id: key,
    label,
    numeric: true,
    render: row =>
      row[key].count === 0 ? (
        <Box component="span" sx={{ color: 'admin.inkMuted' }}>
          -
        </Box>
      ) : (
        <>
          <Money amount={row[key].amount} currency={row.currency} />
          <Box component="span" sx={{ color: 'admin.inkMuted' }}>
            {' '}
            ({row[key].count})
          </Box>
        </>
      ),
  })),
];

const PAYMENT_COLUMNS: readonly DataColumn<BillingPaymentRecord>[] = [
  { id: 'at', label: 'Date', width: '8rem', render: row => formatDay(row.at) },
  { id: 'kind', label: 'Type', width: '9rem', render: row => PAYMENT_KIND_LABELS[row.kind] },
  {
    id: 'label',
    label: 'Detail',
    render: row => (
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <span>{row.label}</span>
        {row.status && row.status !== 'completed' && row.status !== 'paid' && (
          <StatusChip tone="neutral" label={row.status.replace(/_/g, ' ')} />
        )}
      </Stack>
    ),
  },
  {
    id: 'amount',
    label: 'Amount',
    numeric: true,
    render: row => <Money amount={row.amount} currency={row.currency} />,
  },
  {
    id: 'link',
    label: 'Record',
    width: '7rem',
    render: row =>
      row.link ? (
        <BillingLinkTo link={row.link} data-testid={`billing-payment-link-${row.id}`}>
          Open
        </BillingLinkTo>
      ) : null,
  },
];

const PaymentsCard: React.FC<{ section: BillingOverviewData['payments']; window: BillingOverviewData['window'] }> = ({
  section,
  window,
}) => (
  <SectionCard title="Payments" body="custom" data-testid="billing-payments-card">
    {section.status !== 'ok' ? (
      <Unavailable message={section.message} testId="billing-payments-unavailable" />
    ) : (
      <Stack gap={1.5} sx={{ pt: 1.5 }}>
        <CoverageNote testId="billing-payments-coverage">
          {formatDay(window.from)} to {formatDay(window.to)}. Each currency is totalled on its own row.
          {windowStartsBefore(window.from, section.eventsRecordedSince) &&
            ` Subscription payments, refunds and disputes are recorded from ${formatDay(section.eventsRecordedSince!)} on; earlier ones are not shown.`}
          {section.eventsCoverageUnknown &&
            ' When Stripe events began to be recorded could not be loaded, so earlier payments may be missing.'}
          {!section.eventsCoverageUnknown &&
            section.eventsRecordedSince === null &&
            ' No Stripe events are recorded yet, so only credit purchases are shown.'}
          {section.truncated && ' Only the most recent records are listed.'}
        </CoverageNote>
        {section.records.length === 0 ? (
          <Muted data-testid="billing-payments-empty">No payments, refunds or disputes in this window.</Muted>
        ) : (
          <>
            <DataTable
              rows={section.totals}
              columns={TOTAL_COLUMNS}
              getRowId={row => row.currency ?? 'unknown'}
              label="Payment totals by currency"
              onRetry={() => undefined}
              pagination={false}
              testId="billing-payment-totals"
              minWidth="36rem"
            />
            <DataTable
              rows={section.records}
              columns={PAYMENT_COLUMNS}
              getRowId={row => row.id}
              label="Payment records"
              onRetry={() => undefined}
              pagination={false}
              testId="billing-payment-records"
              rowTestId={row => `billing-payment-row-${row.id}`}
              minWidth="40rem"
              maxHeight="24rem"
            />
          </>
        )}
      </Stack>
    )}
  </SectionCard>
);

const billedToLabel = (row: BillingUsageAttribution, ownerType: BillingOwnerType): string => {
  if (ownerType === 'organization') return row.actorName ?? row.actorUserId ?? 'Unknown member';
  if (row.billedTo === 'user') return 'Own balance';
  if (row.billedTo === 'agent') return 'An agent';
  return row.billedToName ?? 'An organization';
};

const usageColumns = (ownerType: BillingOwnerType): readonly DataColumn<BillingUsageAttribution>[] => [
  {
    id: 'who',
    label: ownerType === 'organization' ? 'Member' : 'Billed to',
    render: row =>
      row.link ? (
        <BillingLinkTo link={row.link} data-testid={`billing-usage-link-${row.billedToId}-${row.actorUserId ?? ''}`}>
          {billedToLabel(row, ownerType)}
        </BillingLinkTo>
      ) : (
        billedToLabel(row, ownerType)
      ),
  },
  { id: 'credits', label: 'Credits', numeric: true, render: row => formatCredits(row.credits) },
  { id: 'events', label: 'Requests', numeric: true, render: row => formatCredits(row.events) },
  { id: 'last', label: 'Last request', render: row => <RelativeTime at={row.lastAt} /> },
];

const UsageCard: React.FC<{
  section: BillingOverviewData['usage'];
  window: BillingOverviewData['window'];
  ownerType: BillingOwnerType;
}> = ({ section, window, ownerType }) => (
  <SectionCard
    title="Usage"
    body="custom"
    data-testid="billing-usage-card"
    action={
      section.status === 'ok' && section.link ? (
        <BillingLinkTo link={section.link} data-testid="billing-usage-activity-link">
          View activity
        </BillingLinkTo>
      ) : undefined
    }
  >
    {section.status !== 'ok' ? (
      <Unavailable message={section.message} testId="billing-usage-unavailable" />
    ) : (
      <Stack gap={1.5} sx={{ pt: 1.5 }}>
        <CoverageNote testId="billing-usage-coverage">
          {ownerType === 'user'
            ? 'Charged usage by who paid for it. Own and organization-billed usage are listed apart and never added together.'
            : 'Charged usage this organization paid for, by member.'}
          {' Request counts include failed requests.'}
          {windowStartsBefore(window.from, section.recordedSince) &&
            ` Usage is recorded from ${formatDay(section.recordedSince!)} on.`}
          {section.truncated && ' Only the largest rows are listed.'}
        </CoverageNote>
        <Box sx={{ px: 2 }}>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="billing-usage-last">
            Last successful request:{' '}
            {section.lastSuccessfulAt ? (
              <RelativeTime at={section.lastSuccessfulAt} />
            ) : (
              <Box component="span">never recorded</Box>
            )}
          </Typography>
        </Box>
        {section.attribution.length === 0 ? (
          <Muted data-testid="billing-usage-empty">No charged usage in this window.</Muted>
        ) : (
          <DataTable
            rows={section.attribution}
            columns={usageColumns(ownerType)}
            getRowId={row => `${row.billedTo}:${row.billedToId}:${row.actorUserId ?? ''}`}
            label="Usage by who paid"
            onRetry={() => undefined}
            pagination={false}
            testId="billing-usage-table"
            minWidth="32rem"
          />
        )}
      </Stack>
    )}
  </SectionCard>
);

const ActivityRow: React.FC<{ item: BillingActivityItem; linkedSummary: string | null }> = ({
  item,
  linkedSummary,
}) => (
  <Stack
    component="li"
    direction="row"
    gap={1.5}
    alignItems="baseline"
    flexWrap="wrap"
    sx={{ py: 1, borderBottom: '1px solid', borderColor: 'admin.border', '&:last-of-type': { borderBottom: 0 } }}
    data-testid={`billing-activity-${item.id}`}
  >
    <Typography level="body-xs" sx={{ color: 'admin.inkMuted', minWidth: '6.5rem' }}>
      {formatDay(item.at)}
    </Typography>
    <Typography level="body-sm" sx={{ minWidth: '7rem', color: 'admin.inkMuted' }}>
      {ACTIVITY_KIND_LABELS[item.kind]}
    </Typography>
    <Typography level="body-sm" sx={{ flex: '1 1 12rem', color: 'admin.ink' }}>
      {item.summary}
      {linkedSummary && (
        <Box component="span" sx={{ color: 'admin.inkMuted' }} data-testid={`billing-activity-verified-${item.id}`}>
          {' '}
          (from {linkedSummary}, same Stripe payment)
        </Box>
      )}
    </Typography>
    <Typography level="body-sm" sx={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', minWidth: '7rem' }}>
      {item.credits !== null ? (
        `${signedCredits(item.credits)} credits`
      ) : (
        <Money amount={item.amount} currency={item.currency} />
      )}
    </Typography>
    {item.link && (
      <BillingLinkTo link={item.link} data-testid={`billing-activity-link-${item.id}`}>
        Open
      </BillingLinkTo>
    )}
  </Stack>
);

const ActivityCard: React.FC<{ section: BillingOverviewData['activity'] }> = ({ section }) => {
  if (section.status !== 'ok') {
    return (
      <SectionCard title="Activity" body="custom" data-testid="billing-activity-card">
        <Unavailable message={section.message} testId="billing-activity-unavailable" />
      </SectionCard>
    );
  }
  const byId = new Map(section.items.map(item => [item.id, item]));
  return (
    <SectionCard title="Activity" body="custom" data-testid="billing-activity-card">
      <CoverageNote testId="billing-activity-note">
        Payments, credits added and daily usage, newest first. Credits are tied to a payment only where both records
        name the same Stripe payment; usage is never tied to a payment.
        {section.truncated && ' Only the most recent entries are listed.'}
      </CoverageNote>
      {section.items.length === 0 ? (
        <Muted data-testid="billing-activity-empty">Nothing happened in this window.</Muted>
      ) : (
        <Box component="ul" sx={{ m: 0, px: 2, pb: 1, listStyle: 'none' }}>
          {section.items.map(item => {
            const linked = item.verifiedLinkTo ? byId.get(item.verifiedLinkTo) : undefined;
            return (
              <ActivityRow key={item.id} item={item} linkedSummary={linked ? linked.summary.toLowerCase() : null} />
            );
          })}
        </Box>
      )}
    </SectionCard>
  );
};

const KeyNumbers: React.FC<{ data: BillingOverviewData }> = ({ data }) => {
  const subscription = data.subscription.status === 'ok' ? (data.subscription as Loaded<'subscription'>) : null;
  const credits = data.credits.status === 'ok' ? (data.credits as Loaded<'credits'>) : null;
  const usage = data.usage.status === 'ok' ? (data.usage as Loaded<'usage'>) : null;
  const chip = subscription ? STANDING_CHIPS[subscription.standing] : null;
  return (
    <StatStrip aria-label="Billing key numbers">
      <StatTile
        label="Subscription"
        value={chip ? <StatusChip tone={chip.tone} label={chip.label} /> : 'Unavailable'}
        comparison={subscription?.current?.planName ?? undefined}
      />
      <StatTile
        label="Available credits"
        value={credits ? formatCredits(credits.available) : 'Unavailable'}
        comparison={credits && credits.held > 0 ? `${formatCredits(credits.held)} held` : undefined}
      />
      <StatTile
        label="Last successful usage"
        value={
          usage ? (
            usage.lastSuccessfulAt ? (
              <RelativeTime at={usage.lastSuccessfulAt} />
            ) : (
              'Never recorded'
            )
          ) : (
            'Unavailable'
          )
        }
      />
    </StatStrip>
  );
};

const OverviewBody: React.FC<BillingOverviewProps> = ({ ownerType, ownerId, range, onRangeChange }) => {
  const query = useAdminBillingOverview(ownerType, ownerId, range);
  // keepPreviousData would otherwise show the previous owner's numbers under this owner's header.
  const data = query.data?.owner.id === ownerId ? query.data : undefined;

  const toolbar = (
    <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
      <SegmentedControl
        options={RANGE_OPTIONS}
        value={range}
        onChange={onRangeChange}
        aria-label="Billing window"
        data-testid="billing-range"
      />
      {data?.owner.internal && <StatusChip tone="info" label="Internal account" data-testid="billing-internal-chip" />}
      {data && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted', ml: 'auto' }} data-testid="billing-generated-at">
          Read-only. As of <RelativeTime at={data.generatedAt} />
        </Typography>
      )}
    </Stack>
  );

  if (!data) {
    return (
      <Stack gap={2} data-testid="billing-overview">
        {toolbar}
        {query.isError ? (
          <ErrorState
            message="The billing overview could not be loaded."
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <LoadingState label="Loading billing" testId="billing-overview-loading" />
        )}
      </Stack>
    );
  }

  return (
    <Stack gap={2} data-testid="billing-overview">
      {toolbar}
      <UpdatingBar active={query.isFetching} testId="billing-overview-updating" />
      <KeyNumbers data={data} />
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
        <SubscriptionCard section={data.subscription} />
        <CreditsCard section={data.credits} />
      </Box>
      <PaymentsCard section={data.payments} window={data.window} />
      <UsageCard section={data.usage} window={data.window} ownerType={ownerType} />
      <ActivityCard section={data.activity} />
    </Stack>
  );
};

/**
 * Read-only billing for one user or organization: no action here moves money or credits; every record
 * links to the page that owns it (subscription detail, credit ledger, disputes).
 */
export const BillingOverview: React.FC<BillingOverviewProps> = props => (
  <AdminPermissionGate requirement={CREDITS_PAGE_READ}>
    <OverviewBody {...props} />
  </AdminPermissionGate>
);
