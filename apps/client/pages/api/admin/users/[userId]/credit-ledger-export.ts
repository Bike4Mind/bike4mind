import {
  ADMIN_LEDGER_EXPORT_MAX_ROWS,
  adminLedgerQuerySchema,
  BadRequestError,
  CreditHolderType,
  ForbiddenError,
  NotFoundError,
  transactionTypesForKind,
  type AdminLedgerRow,
} from '@bike4mind/common';
import { creditTransactionRepository, userRepository, withTransaction } from '@bike4mind/database';
import { escapeCsvCell } from '@client/app/utils/csv';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { buildLedgerRows, type LedgerCursor } from '@server/utils/adminCreditLedger';

const EXPORT_PAGE_SIZE = 500;
const MAX_PAGES = Math.ceil(ADMIN_LEDGER_EXPORT_MAX_ROWS / EXPORT_PAGE_SIZE);

const CSV_HEADER = [
  'Time',
  'Kind',
  'Type',
  'Credits',
  'Balance after',
  'Model',
  'Source',
  'API key prefix',
  'Input tokens',
  'Output tokens',
  'Description',
  'Reason',
  'Admin',
  'Admin note',
];

// A number is not a formula, so numeric cells stay raw (escaping would turn -412 into '-412).
const numberCell = (value: number | undefined): string => (value === undefined ? '' : String(value));

const toCsvLine = (row: AdminLedgerRow): string =>
  [
    escapeCsvCell(row.createdAt),
    escapeCsvCell(row.kind),
    escapeCsvCell(row.type),
    numberCell(row.credits),
    numberCell(row.balanceAfter),
    escapeCsvCell(row.model),
    escapeCsvCell(row.source),
    escapeCsvCell(row.apiKeyPrefix),
    numberCell(row.inputTokens),
    numberCell(row.outputTokens),
    escapeCsvCell(row.description),
    escapeCsvCell(row.reason),
    escapeCsvCell(row.actorName ?? row.actorId),
    escapeCsvCell(row.note),
  ].join(',');

/**
 * GET /api/admin/users/[userId]/credit-ledger-export?kind=
 *
 * Streams the user's ledger (optionally one kind) as CSV, newest first, in keyset pages of 500 rows
 * up to ADMIN_LEDGER_EXPORT_MAX_ROWS. Truncation is only known after the last allowed page, when
 * the headers are long gone, so a truncated export ends with a `# Truncated at N rows` line instead
 * of an `X-Export-Truncated` header. Balance-after follows the same rule as the ledger route.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, unknown, unknown, { userId?: string | string[]; kind?: string }>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

    const { userId } = req.query;
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

    const query = adminLedgerQuerySchema.pick({ kind: true }).safeParse({ kind: req.query.kind });
    if (!query.success) throw new BadRequestError(query.error.issues[0]?.message ?? 'Invalid query');
    const { kind } = query.data;

    const types = kind ? transactionTypesForKind(kind) : undefined;
    const readPage = (ownerId: string, after: LedgerCursor | undefined, wanted: number) =>
      // One extra row per page doubles as the probe for "is there more beyond the cap".
      creditTransactionRepository.findLedgerPage(ownerId, CreditHolderType.User, { types, after, limit: wanted + 1 });

    // The balance and the first page come from one snapshot so a row landing between the reads cannot
    // skew the running balance. Later pages carry it forward from rows, so they need no snapshot.
    const firstWanted = Math.min(EXPORT_PAGE_SIZE, ADMIN_LEDGER_EXPORT_MAX_ROWS);
    const { user, firstPage } = await withTransaction(
      async () => {
        const user = await userRepository.findById(userId);
        if (!user) throw new NotFoundError('User not found');
        return { user, firstPage: await readPage(user.id, undefined, firstWanted) };
      },
      { readConcern: { level: 'snapshot' } }
    );

    let after: LedgerCursor | undefined;
    let truncated = false;
    let rowsWritten = 0;
    let carriedBalance: number | undefined;

    try {
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const wanted = Math.min(EXPORT_PAGE_SIZE, ADMIN_LEDGER_EXPORT_MAX_ROWS - rowsWritten);
        const fetched = pageIndex === 0 ? firstPage : await readPage(user.id, after, wanted);
        const hasMore = fetched.length > wanted;
        const documents = hasMore ? fetched.slice(0, wanted) : fetched;

        const balanceAfterFirst = kind || documents.length === 0 ? undefined : (carriedBalance ?? user.currentCredits);
        const rows = await buildLedgerRows(documents, {
          kind,
          balanceAfterFirst,
          userId: user.id,
          logger: req.logger,
        });

        // Headers go out with the first page, after every 4xx check and the first read have succeeded.
        if (pageIndex === 0) {
          const day = new Date().toISOString().slice(0, 10);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="credits-${user.id}-${kind ?? 'all'}-${day}.csv"`);
          res.write(`${CSV_HEADER.map(escapeCsvCell).join(',')}\n`);
        }
        if (rows.length > 0) res.write(`${rows.map(toCsvLine).join('\n')}\n`);
        rowsWritten += rows.length;

        const lastRow = rows[rows.length - 1];
        const lastDocument = documents[documents.length - 1];
        if (!hasMore || !lastRow || !lastDocument) break;
        if (rowsWritten >= ADMIN_LEDGER_EXPORT_MAX_ROWS) {
          truncated = true;
          break;
        }
        after = { createdAt: lastDocument.createdAt, id: lastDocument.id };
        carriedBalance = lastRow.balanceAfter === undefined ? undefined : lastRow.balanceAfter - lastRow.credits;
      }
    } catch (error) {
      // Once the body has started the status line is gone, so a clean error response is impossible:
      // cut the connection so the download fails instead of passing off a partial file as complete.
      if (!res.headersSent) throw error;
      req.logger.error('[ADMIN_LEDGER_EXPORT_FAILED]', { userId: user.id, error });
      res.destroy();
      return;
    }

    if (truncated) res.write(`# Truncated at ${ADMIN_LEDGER_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows\n`);
    res.end();
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
