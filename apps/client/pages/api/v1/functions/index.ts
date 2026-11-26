import { createFunctionContract, listFunctionsContract } from '@bike4mind/common';
import { createCallableFunctionFromCode } from '@bike4mind/server-utils/callableFunctions/authoring';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { paginateById } from '@server/utils/cursorPagination';
import {
  assertFunctionsEnabled,
  functionsRateLimit,
  listLiveFunctions,
  toPublicFunction,
} from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunctionDetail } from '@server/callableFunctions/authoredFunctions';

const CURSOR_SCOPE = 'v1.functions';

const listRoute = nextRouteForContract(listFunctionsContract, {
  rateLimit: functionsRateLimit('/api/v1/functions'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { limit, cursor } = req.validatedQuery;
  const rows = (await listLiveFunctions(req.user)).map(toPublicFunction);
  const page = paginateById(rows, { limit, cursor, scope: CURSOR_SCOPE });
  return res.json({ data: page.items, next_cursor: page.nextCursor });
});

const createRoute = nextRouteForContract(createFunctionContract, {
  rateLimit: functionsRateLimit('POST /api/v1/functions'),
}).post(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const created = await createCallableFunctionFromCode(req.user, req.validated);
  return res.status(201).json({ data: toAuthoredFunctionDetail(created) });
});

export default dispatchByMethod({ GET: listRoute, POST: createRoute });

export const config = {
  api: { externalResolver: true },
};
