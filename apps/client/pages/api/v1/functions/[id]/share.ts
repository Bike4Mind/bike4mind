import { getFunctionShareContract, shareFunctionContract, unshareFunctionContract } from '@bike4mind/common';
import {
  getCallableFunctionShare,
  revokeCallableFunctionShare,
  shareCallableFunction,
} from '@bike4mind/server-utils/callableFunctions/sharing';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunction, toShareInput, toShareView } from '@server/callableFunctions/authoredFunctions';

const getRoute = nextRouteForContract(getFunctionShareContract, {
  rateLimit: functionsRateLimit('GET /api/v1/functions/[id]/share'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  return res.json({ data: toShareView(await getCallableFunctionShare(req.user, req.validatedParams.id)) });
});

const putRoute = nextRouteForContract(shareFunctionContract, {
  rateLimit: functionsRateLimit('PUT /api/v1/functions/[id]/share'),
}).put(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const fn = await shareCallableFunction(req.user, req.validatedParams.id, toShareInput(req.validated));
  return res.json({ data: toAuthoredFunction(fn) });
});

const deleteRoute = nextRouteForContract(unshareFunctionContract, {
  rateLimit: functionsRateLimit('DELETE /api/v1/functions/[id]/share'),
}).delete(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  return res.json({ data: toAuthoredFunction(await revokeCallableFunctionShare(req.user, req.validatedParams.id)) });
});

export default dispatchByMethod({ GET: getRoute, PUT: putRoute, DELETE: deleteRoute });

export const config = {
  api: { externalResolver: true },
};
