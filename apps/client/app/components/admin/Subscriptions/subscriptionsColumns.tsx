import { Box, Stack, Typography } from '@mui/joy';
import { Building2 } from 'lucide-react';
import {
  MRR_CURRENCY,
  countsTowardMrr,
  planIntervalLabel,
  type AdminSubscriptionRow,
  type AdminSubscriptionsSortField,
} from '@client/app/utils/adminSubscriptionsFilter';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import type { DataColumn } from '../shared/DataTable';
import { formatMoney } from '../shared/formatMoney';
import { InitialsAvatar } from '../shared/InitialsAvatar';
import { InlineBar } from '../shared/InlineBar';
import { StatusChip } from '../shared/StatusChip';
import { isNewSince } from './subscriptionsLastSeen';
import { COMPED_DISPLAY, isCompedRow, subscriptionStatusDisplay } from './subscriptionStatusTone';

const DAY_MS = 86_400_000;

/** Columns sortable on the server map to these fields. */
export const SUBSCRIPTIONS_SORT_COLUMNS: Record<string, AdminSubscriptionsSortField> = {
  started: 'createdAt',
  renews: 'periodEndsAt',
};

const isEnded = (status: string) => status === 'canceled' || status === 'incomplete_expired';

/** "in 12d", "3mo ago", "today": whole days, months past 30 days, years past a year. */
export function formatRelativeDay(value: string, now: Date): string {
  const diff = Date.parse(value) - now.getTime();
  const days = Math.floor(Math.abs(diff) / DAY_MS);
  if (days === 0) return 'today';
  const amount = days < 30 ? `${days}d` : days < 365 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days / 365)}y`;
  return diff > 0 ? `in ${amount}` : `${amount} ago`;
}

/** The exact time for a hover title, in UTC. */
export const formatUtc = (value: string) => `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const Dash = ({ title }: { title?: string }) => (
  <Typography component="span" sx={{ color: 'admin.inkMuted' }} aria-label={title ?? 'None'} title={title}>
    {'\u2014'}
  </Typography>
);

const Muted = ({ children, title }: { children: string; title?: string }) => (
  <Typography level="body-sm" component="span" title={title} sx={{ color: 'admin.inkMuted', whiteSpace: 'nowrap' }}>
    {children}
  </Typography>
);

function Customer({ row }: { row: AdminSubscriptionRow }) {
  const owner = row.owner;
  if (!owner) {
    return (
      <Box sx={{ minWidth: 0 }}>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted', fontSize: 13 }}>
          {row.ownerType === 'Organization' ? 'Deleted organization' : 'Deleted account'}
        </Typography>
        <Typography noWrap sx={{ color: 'admin.inkMuted', fontSize: 12, fontFamily: 'code' }}>
          {row.ownerId}
        </Typography>
      </Box>
    );
  }
  const isOrganization = owner.kind === 'Organization';
  const name = isOrganization ? owner.name : owner.name || owner.username || owner.email;
  return (
    <Stack direction="row" alignItems="center" gap={1.25} sx={{ minWidth: 0 }}>
      {isOrganization ? (
        <Box
          aria-hidden
          sx={{
            width: 28,
            height: 28,
            flexShrink: 0,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'admin.hover',
            color: 'admin.inkMuted',
          }}
        >
          <Building2 size={16} strokeWidth={2} />
        </Box>
      ) : (
        <InitialsAvatar name={owner.name ?? undefined} fallback={owner.email ?? owner.username ?? ''} seed={owner.id} />
      )}
      <Box sx={{ minWidth: 0 }}>
        <Typography
          level="body-sm"
          noWrap
          sx={{ color: 'admin.ink', fontWeight: 600, fontSize: 13 }}
          data-testid={`admin-subscriptions-customer-${row.id}`}
        >
          {name || '\u2014'}
        </Typography>
        <Typography noWrap sx={{ color: 'admin.inkMuted', fontSize: 12 }}>
          {isOrganization ? 'Organization' : owner.email}
        </Typography>
      </Box>
    </Stack>
  );
}

function Seats({ row }: { row: AdminSubscriptionRow }) {
  if (row.owner?.kind !== 'Organization' || row.owner.memberCount === null) return <Dash />;
  const used = row.owner.memberCount;
  const paid = row.quantity;
  const over = used > paid;
  return (
    <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1}>
      <Typography
        component="span"
        level="body-sm"
        title={over ? 'More members than paid seats' : undefined}
        sx={{
          color: over ? 'admin.status.warn.foreground' : 'admin.ink',
          fontWeight: over ? 600 : 400,
          whiteSpace: 'nowrap',
        }}
      >
        {`${used.toLocaleString()} / ${paid.toLocaleString()}`}
      </Typography>
      <InlineBar value={used} max={paid} />
    </Stack>
  );
}

// Comps are not revenue: they never show an amount, whatever the row carries.
function Mrr({ row }: { row: AdminSubscriptionRow }) {
  const mrr = isCompedRow(row) ? null : row.mrr;
  const otherCurrency = mrr !== null && mrr.currency !== MRR_CURRENCY;
  return (
    <Box component="span" data-testid={`admin-subscriptions-mrr-${row.id}`}>
      {mrr === null ? (
        countsTowardMrr(row) ? (
          <Box component="span" title="Stripe has no fixed amount for this price yet" sx={{ display: 'inline-flex' }}>
            <StatusChip tone="neutral" label="No amount" data-testid={`admin-subscriptions-mrr-unpriced-${row.id}`} />
          </Box>
        ) : (
          <Dash />
        )
      ) : (
        <Typography
          component="span"
          level="body-sm"
          title={otherCurrency ? `Billed in ${mrr.currency.toUpperCase()}, not in the MRR total` : undefined}
          sx={{ color: otherCurrency ? 'admin.inkMuted' : 'admin.ink', whiteSpace: 'nowrap' }}
        >
          {formatMoney(mrr.amount, mrr.currency)}
        </Typography>
      )}
    </Box>
  );
}

function Renews({ row, now }: { row: AdminSubscriptionRow; now: Date }) {
  if (!row.periodEndsAt) return <Dash />;
  const when = formatRelativeDay(row.periodEndsAt, now);
  const title = formatUtc(row.periodEndsAt);
  if (isEnded(row.status)) return <Muted title={title}>{`Ended ${when}`}</Muted>;
  if (row.canceledAt) return <Muted title={title}>{`Ends ${when}`}</Muted>;
  return <Muted title={title}>{when}</Muted>;
}

function CreditsPerCycle({ row }: { row: AdminSubscriptionRow }) {
  if (row.customCreditsPerCycle !== null) {
    return (
      <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={0.75}>
        <StatusChip tone="neutral" label="custom" data-testid={`admin-subscriptions-custom-credits-${row.id}`} />
        <span>{row.customCreditsPerCycle.toLocaleString()}</span>
      </Stack>
    );
  }
  const credits = row.plan.priceId ? SUBSCRIPTION_PLANS_MAP[row.plan.priceId]?.credits : undefined;
  return credits === undefined ? <Dash /> : <>{credits.toLocaleString()}</>;
}

export function subscriptionsColumns({
  now,
  newSince,
}: {
  now: Date;
  /** Rows started after this get a New chip; null on a browser's first visit. */
  newSince: string | null;
}): DataColumn<AdminSubscriptionRow>[] {
  return [
    {
      id: 'customer',
      label: 'Customer',
      width: '11rem',
      render: row => <Customer row={row} />,
    },
    {
      id: 'plan',
      label: 'Plan',
      width: '6.5rem',
      render: row => {
        const interval = planIntervalLabel(row);
        return (
          <Box sx={{ minWidth: 0 }}>
            {row.plan.name ? (
              <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
                {row.plan.name}
              </Typography>
            ) : (
              <Box component="span" title="Price ID not in the plan catalog" sx={{ display: 'inline-flex' }}>
                <StatusChip
                  tone="warn"
                  label="Unknown plan"
                  data-testid={`admin-subscriptions-unknown-plan-${row.id}`}
                />
              </Box>
            )}
            {interval && (
              <Typography
                sx={{ color: 'admin.inkMuted', fontSize: 12 }}
                data-testid={`admin-subscriptions-interval-${row.id}`}
              >
                {interval}
              </Typography>
            )}
          </Box>
        );
      },
    },
    {
      id: 'status',
      label: 'Status',
      width: '9.75rem',
      render: row => {
        const status = subscriptionStatusDisplay(row);
        return (
          <Stack direction="row" alignItems="center" gap={0.5} flexWrap="nowrap">
            <StatusChip
              dot
              tone={status.tone}
              label={status.label}
              data-testid={`admin-subscriptions-status-${row.id}`}
            />
            {isCompedRow(row) && (
              <StatusChip
                tone={COMPED_DISPLAY.tone}
                label={COMPED_DISPLAY.label}
                data-testid={`admin-subscriptions-comped-${row.id}`}
              />
            )}
          </Stack>
        );
      },
    },
    {
      id: 'mrr',
      label: `MRR (${MRR_CURRENCY.toUpperCase()})`,
      numeric: true,
      width: '5.5rem',
      render: row => <Mrr row={row} />,
    },
    {
      id: 'seats',
      label: 'Seats',
      numeric: true,
      width: '7.5rem',
      render: row => <Seats row={row} />,
    },
    {
      id: 'renews',
      label: 'Renews',
      sortable: true,
      width: '6rem',
      render: row => <Renews row={row} now={now} />,
    },
    {
      id: 'credits',
      label: 'Credits / cycle',
      numeric: true,
      width: '7rem',
      render: row => <CreditsPerCycle row={row} />,
    },
    {
      id: 'started',
      label: 'Started',
      sortable: true,
      width: '7rem',
      render: row => (
        <Stack direction="row" alignItems="center" gap={0.75}>
          {row.createdAt ? (
            <Muted title={formatUtc(row.createdAt)}>{formatRelativeDay(row.createdAt, now)}</Muted>
          ) : (
            <Dash />
          )}
          {row.source === 'stripe' && isNewSince(row.createdAt, newSince) && (
            <StatusChip tone="info" label="New" data-testid={`admin-subscriptions-new-${row.id}`} />
          )}
        </Stack>
      ),
    },
  ];
}
