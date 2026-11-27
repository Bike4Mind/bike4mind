import { promoteFunctionContract } from '@bike4mind/common';
import { promoteCallableFunction } from '@bike4mind/server-utils/callableFunctions/promote';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toPromotion } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(promoteFunctionContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/promote'),
}).post(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  return res.json({ data: toPromotion(await promoteCallableFunction(req.user, req.validatedParams.id)) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
