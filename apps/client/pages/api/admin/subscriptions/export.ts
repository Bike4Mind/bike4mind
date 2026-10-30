import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { moneyFractionDigits, toMajorUnits } from '@client/app/components/admin/shared/formatMoney';
import {
  ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS,
  ADMIN_SUBSCRIPTIONS_LIST_MAX,
  AdminSubscriptionsFilterSchema,
  planIntervalLabel,
  type AdminSubscriptionMrr,
  type AdminSubscriptionRow,
} from '@client/app/utils/adminSubscriptionsFilter';
import { escapeCsvCell } from '@client/app/utils/csv';
import {
  adminSubscriptionsExportPage,
  adminSubscriptionsMatch,
  OWNER_SEARCH_LIMIT,
  type ExportCursor,
} from '@server/admin/subscriptionsList/listAdminSubscriptions';
import { subscriptionPlanCatalog } from '@server/admin/subscriptionsList/adminSubscriptionsQuery';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import qs from 'qs';

const EXPORT_PAGE_SIZE = 500;
const MAX_PAGES = Math.ceil(ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS / EXPORT_PAGE_SIZE);

const CSV_HEADER = [
  'Created',
  'Customer',
  'Email',
  'Owner type',
  'Owner id',
  'Stripe customer id',
  'Plan',
  'Interval',
  'Price id',
  'Status',
  'Source',
  'MRR',
  'MRR currency',
  'Quantity',
  'Seats',
  'Members',
  'Credits per cycle',
  'Period start',
  'Period end',
  'Canceled at',
  'Subscription id',
];

// A number is not a formula, so numeric cells stay raw (escaping would turn -412 into '-412).
const numberCell = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

// Major units at the currency's precision ("19.00"), so a spreadsheet sums the column as money.
const moneyCell = (mrr: AdminSubscriptionMrr | null): string =>
  mrr ? toMajorUnits(mrr.amount, mrr.currency).toFixed(moneyFractionDigits(mrr.currency)) : '';

const toCsvLine = (row: AdminSubscriptionRow): string => {
  const owner = row.owner;
  const organization = owner?.kind === 'Organization' ? owner : null;
  return [
    escapeCsvCell(row.createdAt),
    escapeCsvCell(owner?.name ?? ''),
    escapeCsvCell(owner?.kind === 'User' ? (owner.email ?? '') : ''),
    escapeCsvCell(row.ownerType),
    escapeCsvCell(row.ownerId),
    escapeCsvCell(owner?.stripeCustomerId ?? ''),
    escapeCsvCell(row.plan.name ?? 'Unknown plan'),
    escapeCsvCell(planIntervalLabel(row) ?? ''),
    escapeCsvCell(row.plan.priceId ?? ''),
    escapeCsvCell(row.status),
    escapeCsvCell(row.source),
    moneyCell(row.mrr),
    escapeCsvCell(row.mrr?.currency.toUpperCase() ?? ''),
    numberCell(row.quantity),
    numberCell(organization?.seats),
    numberCell(organization?.memberCount),
    numberCell(row.customCreditsPerCycle),
    escapeCsvCell(row.periodStartsAt),
    escapeCsvCell(row.periodEndsAt),
    escapeCsvCell(row.canceledAt ?? ''),
    escapeCsvCell(row.subscriptionId),
  ].join(',');
};

/**
 * GET /api/admin/subscriptions/export?<filters>
 *
 * Streams the filtered subscriptions as CSV, newest first, in keyset pages of 500 rows up to
 * ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS. Truncation is only known after the headers are sent, so a
 * truncated export ends with a `# Truncated at N rows` line, and a search that resolved only some of its
 * owners ends with a line saying so. Same shape as the credit ledger export.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 6, windowMs: 60_000, bucket: 'admin-subscriptions-export' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const parsed = AdminSubscriptionsFilterSchema.safeParse(
        qs.parse(req.query as Record<string, string>, { arrayLimit: ADMIN_SUBSCRIPTIONS_LIST_MAX })
      );
      if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query parameters', error: parsed.error.issues });
      }

      const catalog = subscriptionPlanCatalog();
      const { match, searchTruncated } = await adminSubscriptionsMatch(parsed.data, new Date(), catalog);
      let after: ExportCursor | null = null;
      let truncated = false;
      let rowsWritten = 0;

      try {
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
          const wanted = Math.min(EXPORT_PAGE_SIZE, ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS - rowsWritten);
          // One extra row doubles as the probe for "is there more".
          const fetched = await adminSubscriptionsExportPage(match, after, wanted + 1, catalog);
          const hasMore = fetched.length > wanted;
          const rows = hasMore ? fetched.slice(0, wanted) : fetched;

          // Headers go out with the first page, after validation and the first read have succeeded.
          if (pageIndex === 0) {
            const day = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="subscriptions-${day}.csv"`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.write(`${CSV_HEADER.map(escapeCsvCell).join(',')}\n`);
          }
          if (rows.length > 0) res.write(`${rows.map(toCsvLine).join('\n')}\n`);
          rowsWritten += rows.length;

          const last = rows[rows.length - 1];
          if (!hasMore || !last) break;
          if (rowsWritten >= ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS) {
            truncated = true;
            break;
          }
          after = { createdAt: last.createdAt ? new Date(last.createdAt) : null, id: last.id };
        }
      } catch (error) {
        // Once the body has started the status line is gone: cut the connection so the download fails
        // instead of passing off a partial file as complete.
        if (!res.headersSent) throw error;
        req.logger.error('[ADMIN_SUBSCRIPTIONS_EXPORT_FAILED]', { error });
        res.destroy();
        return;
      }

      if (truncated) {
        res.write(`# Truncated at ${ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows\n`);
      }
      if (searchTruncated) {
        res.write(`# Search matched more than ${OWNER_SEARCH_LIMIT} owners; narrow it to export every match\n`);
      }
      res.end();
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
