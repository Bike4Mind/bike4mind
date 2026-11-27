import { FC } from 'react';
import { Box, Button, Chip, CircularProgress, Divider, Link, Stack, Typography, type ChipProps } from '@mui/joy';
import dayjs from 'dayjs';
import { formatMoney } from '@client/app/components/admin/shared/formatMoney';
import { useOrgInvoices } from '@client/app/hooks/data/useOrgInvoices';
import type { OrgInvoice } from '@client/app/utils/orgInvoices';

const STATUS_VIEW: Record<string, { label: string; color: ChipProps['color'] }> = {
  paid: { label: 'Paid', color: 'success' },
  open: { label: 'Open', color: 'warning' },
  uncollectible: { label: 'Uncollectible', color: 'danger' },
  void: { label: 'Void', color: 'neutral' },
};

const statusView = (status: string) => STATUS_VIEW[status] ?? { label: status, color: 'neutral' as const };

// Keyed off the list's own width, not the viewport: the org page's tab rail leaves the Billing
// column far narrower than the screen. Below this the row stacks and its details wrap.
const WIDE_ROW = '@container (min-width: 32rem)';

// What the invoice charged: a paid one shows what was collected, anything else what is owed.
const invoiceAmount = (invoice: OrgInvoice) => (invoice.status === 'paid' ? invoice.amountPaid : invoice.amountDue);

/** The org's recent Stripe invoices with links to each hosted invoice and its PDF. Owner only. */
const OrganizationInvoiceList: FC<{ organizationId: string }> = ({ organizationId }) => {
  const { data, isLoading, isError, refetch } = useOrgInvoices(organizationId);

  if (isLoading) return <CircularProgress size="sm" data-testid="org-invoices-loading" />;
  if (isError || !data) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" data-testid="org-invoices-error">
        <Typography level="body-sm">Could not load invoices.</Typography>
        <Button size="sm" variant="plain" onClick={() => void refetch()} data-testid="org-invoices-retry-btn">
          Retry
        </Button>
      </Stack>
    );
  }

  if (data.invoices.length === 0) {
    return (
      <Typography level="body-sm" color="neutral" data-testid="org-invoices-empty">
        No invoices yet.
      </Typography>
    );
  }

  return (
    <Stack divider={<Divider />} spacing={1.5} sx={{ containerType: 'inline-size' }} data-testid="org-invoices">
      {data.invoices.map(invoice => {
        const status = statusView(invoice.status);
        return (
          <Box
            key={invoice.id}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
              [WIDE_ROW]: { flexDirection: 'row', alignItems: 'center', gap: 2 },
            }}
            data-testid="org-invoices-row"
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="body-md">{dayjs(invoice.createdAt).format('MMM D, YYYY')}</Typography>
              <Typography level="body-xs" color="neutral" noWrap>
                {invoice.number ?? invoice.id}
              </Typography>
            </Box>
            {/* Wide rows fix the widths so amount, status and links line up in columns across rows. */}
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: 2,
                rowGap: 0.5,
                [WIDE_ROW]: { flexWrap: 'nowrap', flexShrink: 0 },
              }}
            >
              <Typography
                level="body-md"
                sx={{ [WIDE_ROW]: { minWidth: '6rem', textAlign: 'right' } }}
                data-testid="org-invoices-amount"
              >
                {formatMoney(invoiceAmount(invoice), invoice.currency)}
              </Typography>
              <Box sx={{ [WIDE_ROW]: { width: '7rem' } }}>
                <Chip size="sm" variant="soft" color={status.color} data-testid="org-invoices-status">
                  {status.label}
                </Chip>
              </Box>
              <Stack direction="row" spacing={1.5} sx={{ [WIDE_ROW]: { width: '5rem' } }}>
                {invoice.hostedInvoiceUrl && (
                  <Link
                    href={invoice.hostedInvoiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    level="body-sm"
                    data-testid="org-invoices-view-link"
                  >
                    View
                  </Link>
                )}
                {invoice.invoicePdf && (
                  <Link
                    href={invoice.invoicePdf}
                    target="_blank"
                    rel="noopener noreferrer"
                    level="body-sm"
                    data-testid="org-invoices-pdf-link"
                  >
                    PDF
                  </Link>
                )}
              </Stack>
            </Box>
          </Box>
        );
      })}
      {data.hasMore && (
        <Typography level="body-xs" color="neutral" data-testid="org-invoices-more">
          Showing the {data.invoices.length} most recent invoices. The Billing Portal has the full history.
        </Typography>
      )}
    </Stack>
  );
};

export default OrganizationInvoiceList;
