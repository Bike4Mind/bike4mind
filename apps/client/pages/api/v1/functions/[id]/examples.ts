import { setFunctionExamplesContract } from '@bike4mind/common';
import { setCallableFunctionExamples } from '@bike4mind/server-utils/callableFunctions/registry';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunction } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(setFunctionExamplesContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/examples'),
}).put(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const fn = await setCallableFunctionExamples(req.user, req.validatedParams.id, req.validated.examples);
  return res.json({ data: toAuthoredFunction(fn) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
