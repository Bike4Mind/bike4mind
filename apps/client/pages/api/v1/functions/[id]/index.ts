import { deleteFunctionContract, getFunctionContract, updateFunctionContract } from '@bike4mind/common';
import {
  deleteCallableFunction,
  updateCallableFunctionSettings,
} from '@bike4mind/server-utils/callableFunctions/registry';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import {
  assertFunctionsEnabled,
  functionsRateLimit,
  resolveCallableFunction,
  toPublicFunctionDetail,
} from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunction } from '@server/callableFunctions/authoredFunctions';

const getRoute = nextRouteForContract(getFunctionContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const fn = await resolveCallableFunction(req.user, req.validatedParams.id);
  return res.json({ data: await toPublicFunctionDetail(fn) });
});

const updateRoute = nextRouteForContract(updateFunctionContract, {
  rateLimit: functionsRateLimit('PATCH /api/v1/functions/[id]'),
}).patch(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const fn = await updateCallableFunctionSettings(req.user, req.validatedParams.id, req.validated);
  return res.json({ data: toAuthoredFunction(fn) });
});

const deleteRoute = nextRouteForContract(deleteFunctionContract, {
  rateLimit: functionsRateLimit('DELETE /api/v1/functions/[id]'),
}).delete(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  await deleteCallableFunction(req.user, req.validatedParams.id);
  return res.status(204).end();
});

export default dispatchByMethod({ GET: getRoute, PATCH: updateRoute, DELETE: deleteRoute });

export const config = {
  api: { externalResolver: true },
};
