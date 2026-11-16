import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import { Building2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminPaymentRow } from '@bike4mind/server-utils/app/utils/adminPayments';
import { Dash } from '../../shared/Dash';
import type { DataColumn } from '../../shared/DataTable';
import { formatMoney } from '../../shared/formatMoney';
import { InitialsAvatar } from '../../shared/InitialsAvatar';
import { StatusChip } from '../../shared/StatusChip';
import { adminFocus } from '../../shared/adminStyles';
import { PAYMENT_KIND_LABEL, PAYMENT_STATUS_DISPLAY } from './paymentStatusTone';

/** "2026-11-10 14:32": the column header names the zone. */
export const formatPaymentTime = (iso: string): string => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

function Customer({ row }: { row: AdminPaymentRow }) {
  const owner = row.owner;
  if (!owner) {
    return (
      <Box sx={{ minWidth: 0 }}>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted', fontSize: 13 }}>
          Deleted customer
        </Typography>
        <Typography noWrap sx={{ color: 'admin.inkMuted', fontSize: 12, fontFamily: 'code' }}>
          {row.ownerId}
        </Typography>
      </Box>
    );
  }
  const isOrganization = owner.kind === 'organization';
  const name = isOrganization ? owner.name : owner.name || owner.email;
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
        <InitialsAvatar name={owner.name ?? undefined} fallback={owner.email ?? ''} seed={owner.id} />
      )}
      <Box sx={{ minWidth: 0 }}>
        <Typography
          level="body-sm"
          noWrap
          sx={{ color: 'admin.ink', fontWeight: 600, fontSize: 13 }}
          data-testid={`admin-payments-customer-${row.id}`}
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

async function copyReference(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success('Reference copied');
  } catch {
    toast.error('Could not copy the reference.');
  }
}

function Reference({ row }: { row: AdminPaymentRow }) {
  const reference = row.paymentIntentId ?? row.invoiceId;
  if (!reference) return <Dash />;
  return (
    <Stack direction="row" alignItems="center" gap={0.5} sx={{ minWidth: 0 }}>
      <Typography
        component="span"
        noWrap
        title={reference}
        sx={{ color: 'admin.inkMuted', fontFamily: 'code', fontSize: 12, maxWidth: '11rem' }}
      >
        {reference}
      </Typography>
      <Tooltip title="Copy reference">
        <IconButton
          size="sm"
          variant="plain"
          aria-label={`Copy reference ${reference}`}
          data-testid={`admin-payments-copy-ref-${row.id}-btn`}
          onClick={event => {
            event.stopPropagation();
            void copyReference(reference);
          }}
          sx={{ ...adminFocus, '--IconButton-size': '22px', minHeight: 22, minWidth: 22, color: 'admin.inkMuted' }}
        >
          <ContentCopyRoundedIcon sx={{ fontSize: 13 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

export function paymentsColumns(): DataColumn<AdminPaymentRow>[] {
  return [
    {
      id: 'date',
      label: 'Date (UTC)',
      width: '9.5rem',
      render: row => (
        <Typography component="span" level="body-sm" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {formatPaymentTime(row.occurredAt)}
        </Typography>
      ),
    },
    { id: 'customer', label: 'Customer', render: row => <Customer row={row} /> },
    {
      id: 'type',
      label: 'Type',
      render: row => (
        <StatusChip tone="neutral" label={PAYMENT_KIND_LABEL[row.kind]} data-testid={`admin-payments-type-${row.id}`} />
      ),
    },
    {
      id: 'status',
      label: 'Status',
      render: row => {
        const display = PAYMENT_STATUS_DISPLAY[row.status];
        return <StatusChip tone={display.tone} label={display.label} data-testid={`admin-payments-status-${row.id}`} />;
      },
    },
    {
      id: 'amount',
      label: 'Amount',
      numeric: true,
      render: row => formatMoney(row.amount, row.currency),
    },
    {
      id: 'refunded',
      label: 'Refunded',
      numeric: true,
      render: row =>
        row.refundedAmount ? formatMoney(-row.refundedAmount, row.currency) : <Dash title="Nothing refunded" />,
    },
    {
      id: 'credits',
      label: 'Credits',
      numeric: true,
      render: row => (row.credits === null ? <Dash title="Not a credit purchase" /> : row.credits.toLocaleString()),
    },
    { id: 'reference', label: 'Reference', render: row => <Reference row={row} /> },
  ];
}
