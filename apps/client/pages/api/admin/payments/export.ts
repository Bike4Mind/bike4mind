import { ApiKeyScope } from '@bike4mind/common';
import { moneyFractionDigits, toMajorUnits } from '@client/app/components/admin/shared/formatMoney';
import {
  ADMIN_PAYMENTS_EXPORT_MAX_ROWS,
  AdminPaymentsFilterSchema,
  resolvePaymentsWindow,
  type AdminPaymentRow,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import { escapeCsvCell } from '@client/app/utils/csv';
import { exportAdminPayments } from '@server/admin/payments/adminPayments';
import { PAYMENTS_OWNER_SEARCH_LIMIT } from '@server/admin/payments/paymentsQuery';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@server/middlewares/rateLimit';

/** Comma-separated `truncated` / `search_truncated`, present only when the file is incomplete. */
export const PAYMENTS_EXPORT_NOTES_HEADER = 'X-Export-Notes';

export const PAYMENTS_CSV_HEADER = [
  'Date (UTC)',
  'Type',
  'Status',
  'Customer',
  'Email',
  'Owner type',
  'Owner id',
  'Amount',
  'Refunded',
  'Currency',
  'Credits',
  'Payment intent',
  'Invoice',
  'Subscription',
];

/** Appended as `#` lines, the same convention as the subscriptions and credit ledger exports. */
export const PAYMENTS_CSV_DEFINITIONS = [
  'Amount and Refunded are in major units of the Currency column, as charged to the customer; Stripe fees are not deducted.',
  'Refunded is the cumulative amount refunded so far. Status: succeeded, pending, failed, refunded, partially_refunded, disputed (open), dispute_lost.',
  'Credit purchases come from the credit ledger; subscription payments from recorded Stripe invoice events, one row per invoice.',
];

const numberCell = (value: number | null): string => (value === null ? '' : String(value));

const moneyCell = (amount: number | null, currency: string): string =>
  amount === null ? '' : toMajorUnits(amount, currency).toFixed(moneyFractionDigits(currency));

export const toPaymentCsvLine = (row: AdminPaymentRow): string =>
  [
    escapeCsvCell(row.occurredAt),
    escapeCsvCell(row.kind),
    escapeCsvCell(row.status),
    escapeCsvCell(row.owner?.name ?? ''),
    escapeCsvCell(row.owner?.kind === 'user' ? (row.owner.email ?? '') : ''),
    escapeCsvCell(row.ownerType),
    escapeCsvCell(row.ownerId),
    moneyCell(row.amount, row.currency),
    moneyCell(row.refundedAmount, row.currency),
    escapeCsvCell(row.currency.toUpperCase()),
    numberCell(row.credits),
    escapeCsvCell(row.paymentIntentId ?? ''),
    escapeCsvCell(row.invoiceId ?? ''),
    escapeCsvCell(row.subscriptionId ?? ''),
  ].join(',');

/**
 * GET /api/admin/payments/export?<filters>
 *
 * Read-only. The filtered payments as CSV, newest first, up to ADMIN_PAYMENTS_EXPORT_MAX_ROWS, followed by
 * `#` lines with the range, the definitions and any truncation.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit({ limit: 6, windowMs: 60_000, bucket: 'admin-payments-export' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = AdminPaymentsFilterSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }
      const now = new Date();
      const window = resolvePaymentsWindow(parsed.data, now);
      // One extra row doubles as the probe for "is there more".
      const { rows, searchTruncated } = await exportAdminPayments(parsed.data, ADMIN_PAYMENTS_EXPORT_MAX_ROWS + 1, now);
      const truncated = rows.length > ADMIN_PAYMENTS_EXPORT_MAX_ROWS;
      const lines = [
        PAYMENTS_CSV_HEADER.map(escapeCsvCell).join(','),
        ...rows.slice(0, ADMIN_PAYMENTS_EXPORT_MAX_ROWS).map(toPaymentCsvLine),
        `# Range: ${window.from} to ${window.to} (UTC, inclusive)`,
        ...PAYMENTS_CSV_DEFINITIONS.map(line => `# ${line}`),
        ...(truncated ? [`# Truncated at ${ADMIN_PAYMENTS_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows`] : []),
        ...(searchTruncated
          ? [`# Search matched more than ${PAYMENTS_OWNER_SEARCH_LIMIT} owners; narrow it to export every match`]
          : []),
      ];
      // The `#` lines say the same for a reader of the file; the header lets the page warn without parsing it.
      const notes = [...(truncated ? ['truncated'] : []), ...(searchTruncated ? ['search_truncated'] : [])];
      if (notes.length > 0) res.setHeader(PAYMENTS_EXPORT_NOTES_HEADER, notes.join(','));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="payments-${window.from}-to-${window.to}.csv"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(`${lines.join('\n')}\n`);
    })
  );

export default handler;
