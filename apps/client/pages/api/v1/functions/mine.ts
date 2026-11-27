import { listAuthoredFunctionsContract } from '@bike4mind/common';
import { listCallableFunctions } from '@bike4mind/server-utils/callableFunctions/registry';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { paginateById } from '@server/utils/cursorPagination';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunction } from '@server/callableFunctions/authoredFunctions';

const CURSOR_SCOPE = 'v1.functions.mine';

const handler = nextRouteForContract(listAuthoredFunctionsContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/mine'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { limit, cursor } = req.validatedQuery;
  const rows = (await listCallableFunctions(req.user)).map(toAuthoredFunction);
  const page = paginateById(rows, { limit, cursor, scope: CURSOR_SCOPE });
  return res.json({ data: page.items, next_cursor: page.nextCursor });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
