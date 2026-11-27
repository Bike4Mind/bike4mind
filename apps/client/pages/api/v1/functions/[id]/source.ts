import { getAuthoredFunctionContract } from '@bike4mind/common';
import { getCallableFunction } from '@bike4mind/server-utils/callableFunctions/registry';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunctionDetail } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(getAuthoredFunctionContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/source'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ data: toAuthoredFunctionDetail(await getCallableFunction(req.user, req.validatedParams.id)) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
