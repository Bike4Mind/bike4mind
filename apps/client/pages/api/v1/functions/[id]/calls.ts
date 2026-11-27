import { getFunctionCallSummaryContract } from '@bike4mind/common';
import { summarizeCallableFunctionCalls } from '@bike4mind/server-utils/callableFunctions/registry';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toCallSummary } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(getFunctionCallSummaryContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/calls'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  return res.json({ data: toCallSummary(await summarizeCallableFunctionCalls(req.user, req.validatedParams.id)) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
