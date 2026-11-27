/**
 * GET /api/v1/functions - the functions the key's owner can call, their own and those shared with them and reviewed,
 * cursor-paginated (`listFunctionsContract`).
 */
import { listFunctionsContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { paginateById } from '@server/utils/cursorPagination';
import {
  assertFunctionsEnabled,
  functionsRateLimit,
  listLiveFunctions,
  toPublicFunction,
} from '@server/callableFunctions/publicFunctions';

const CURSOR_SCOPE = 'v1.functions';

const handler = nextRouteForContract(listFunctionsContract, {
  rateLimit: functionsRateLimit('/api/v1/functions'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { limit, cursor } = req.validatedQuery;
  const rows = (await listLiveFunctions(req.user)).map(toPublicFunction);
  const page = paginateById(rows, { limit, cursor, scope: CURSOR_SCOPE });
  return res.json({ data: page.items, next_cursor: page.nextCursor });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
