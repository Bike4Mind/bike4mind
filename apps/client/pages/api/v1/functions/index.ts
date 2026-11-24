/**
 * GET /api/v1/functions - the key owner's live functions, cursor-paginated (`listFunctionsContract`).
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
  const page = paginateById(await listLiveFunctions(req.user), { limit, cursor, scope: CURSOR_SCOPE });
  return res.json({ data: page.items.map(toPublicFunction), next_cursor: page.nextCursor });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
