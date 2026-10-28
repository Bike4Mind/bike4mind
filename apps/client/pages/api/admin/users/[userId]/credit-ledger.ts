import {
  ADMIN_LEDGER_PAGE_SIZE,
  adminLedgerPageSchema,
  adminLedgerQuerySchema,
  BadRequestError,
  CreditHolderType,
  ForbiddenError,
  NotFoundError,
  transactionTypesForKind,
} from '@bike4mind/common';
import { creditTransactionRepository, userRepository, withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  balanceAfterFirstRow,
  buildLedgerRows,
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '@server/utils/adminCreditLedger';
import { respond } from '@server/utils/respond';

type LedgerRequestQuery = { userId?: string | string[]; kind?: string; cursor?: string; limit?: string };

/**
 * GET /api/admin/users/[userId]/credit-ledger?kind=&cursor=&limit=
 *
 * One keyset page of the user's full credit ledger, newest first. `nextCursor` is opaque and
 * null on the last page. Unfiltered pages carry a running `balanceAfter` rebuilt from the user's
 * current balance; kind-filtered pages are not contiguous, so only admin adjustments carry the
 * balance recorded when they were written.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, unknown, unknown, LedgerRequestQuery>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

    const { userId } = req.query;
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

    const query = adminLedgerQuerySchema.safeParse({
      kind: req.query.kind,
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    if (!query.success) throw new BadRequestError(query.error.issues[0]?.message ?? 'Invalid query');
    const { kind, cursor, limit = ADMIN_LEDGER_PAGE_SIZE } = query.data;

    const after = cursor ? decodeLedgerCursor(cursor) : undefined;

    // One snapshot for the balance and the page: a row landing between separate reads would shift
    // every balanceAfter on the page by its amount.
    const { user, documents, hasMore, balanceAfterFirst } = await withTransaction(
      async () => {
        const user = await userRepository.findById(userId);
        if (!user) throw new NotFoundError('User not found');

        // One extra row tells us whether a next page exists without a count query.
        const fetched = await creditTransactionRepository.findLedgerPage(user.id, CreditHolderType.User, {
          types: kind ? transactionTypesForKind(kind) : undefined,
          after,
          limit: limit + 1,
        });
        const hasMore = fetched.length > limit;
        const documents = hasMore ? fetched.slice(0, limit) : fetched;

        const balanceAfterFirst =
          !kind && documents.length > 0
            ? await balanceAfterFirstRow(user.id, user.currentCredits, documents[0], !after)
            : undefined;
        return { user, documents, hasMore, balanceAfterFirst };
      },
      { readConcern: { level: 'snapshot' } }
    );
    const rows = await buildLedgerRows(documents, { kind, balanceAfterFirst, userId: user.id, logger: req.logger });

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
