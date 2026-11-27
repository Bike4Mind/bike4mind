import { setFunctionSourcesContract } from '@bike4mind/common';
import { setCallableFunctionSources } from '@bike4mind/server-utils/callableFunctions/sources';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunction } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(setFunctionSourcesContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/sources'),
}).put(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const fn = await setCallableFunctionSources(req.user, req.validatedParams.id, req.validated.sources);
  return res.json({ data: toAuthoredFunction(fn) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
