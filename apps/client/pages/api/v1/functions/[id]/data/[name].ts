import { unpinFunctionDataContract } from '@bike4mind/common';
import { unpinCallableFunctionData } from '@bike4mind/server-utils/callableFunctions/dataPins';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunction } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(unpinFunctionDataContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/data/[name]'),
}).delete(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { id, name } = req.validatedParams;
  return res.json({ data: toAuthoredFunction(await unpinCallableFunctionData(req.user, id, name)) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
