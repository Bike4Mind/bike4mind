import {
  ADMIN_LEDGER_PAGE_SIZE,
  adminLedgerPageSchema,
  adminLedgerQuerySchema,
  BadRequestError,
  CreditHolderType,
  ForbiddenError,
  isContiguousLedgerFilter,
  NotFoundError,
} from '@bike4mind/common';
import { creditTransactionRepository, userRepository, withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  balanceAfterFirstRow,
  buildLedgerRows,
  decodeLedgerCursor,
  encodeLedgerCursor,
  ledgerPageFilter,
} from '@server/utils/adminCreditLedger';
import { respond } from '@server/utils/respond';

type LedgerRequestQuery = {
  userId?: string | string[];
  kind?: string;
  model?: string;
  source?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
};

/**
 * GET /api/admin/users/[userId]/credit-ledger?kind=&model=&source=&from=&to=&cursor=&limit=
 *
 * One keyset page of the user's credit ledger, newest first. `from` and `to` are inclusive UTC days.
 * `nextCursor` is opaque and null on the last page. Contiguous pages (no kind, model or source filter)
 * carry a running `balanceAfter` rebuilt from the user's current balance; otherwise only admin
 * adjustments carry the balance recorded when they were written.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, unknown, unknown, LedgerRequestQuery>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

    const { userId } = req.query;
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

    const { kind, model, source, from, to, cursor, limit: rawLimit } = req.query;
    const query = adminLedgerQuerySchema.safeParse({ kind, model, source, from, to, cursor, limit: rawLimit });
    if (!query.success) throw new BadRequestError(query.error.issues[0]?.message ?? 'Invalid query');
    const { cursor: validCursor, limit = ADMIN_LEDGER_PAGE_SIZE, ...filter } = query.data;
    const contiguous = isContiguousLedgerFilter(filter);

    const after = validCursor ? decodeLedgerCursor(validCursor) : undefined;

    // One snapshot for the balance and the page: a row landing between separate reads would shift
    // every balanceAfter on the page by its amount.
    const { user, documents, hasMore, balanceAfterFirst } = await withTransaction(
      async () => {
        const user = await userRepository.findById(userId);
        if (!user) throw new NotFoundError('User not found');

        // One extra row tells us whether a next page exists without a count query.
        const fetched = await creditTransactionRepository.findLedgerPage(user.id, CreditHolderType.User, {
          ...ledgerPageFilter(filter),
          after,
          limit: limit + 1,
        });
        const hasMore = fetched.length > limit;
        const documents = hasMore ? fetched.slice(0, limit) : fetched;

        const balanceAfterFirst =
          contiguous && documents.length > 0
            ? await balanceAfterFirstRow(user.id, user.currentCredits, documents[0], !after && !filter.to)
            : undefined;
        return { user, documents, hasMore, balanceAfterFirst };
      },
      { readConcern: { level: 'snapshot' } }
    );
    const rows = await buildLedgerRows(documents, {
      contiguous,
      balanceAfterFirst,
      userId: user.id,
      logger: req.logger,
    });

    const last = documents[documents.length - 1];
    const nextCursor = hasMore && last ? encodeLedgerCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return respond(res, adminLedgerPageSchema, { rows, nextCursor });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
