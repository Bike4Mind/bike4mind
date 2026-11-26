/**
 * GET /api/v1/functions/{id} - one live function with its contract (`getFunctionContract`).
 */
import { getFunctionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  assertFunctionsEnabled,
  functionsRateLimit,
  loadLiveFunction,
  toPublicFunctionDetail,
} from '@server/callableFunctions/publicFunctions';

const handler = nextRouteForContract(getFunctionContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const fn = await loadLiveFunction(req.user, req.validatedParams.id);
  return res.json({ data: toPublicFunctionDetail(fn) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
