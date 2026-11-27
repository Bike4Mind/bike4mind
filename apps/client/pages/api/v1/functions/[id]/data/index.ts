import { pinFunctionDataContract } from '@bike4mind/common';
import { pinCallableFunctionData } from '@bike4mind/server-utils/callableFunctions/dataPins';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunction } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(pinFunctionDataContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/data'),
}).post(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { file_id, name } = req.validated;
  const fn = await pinCallableFunctionData(req.user, req.validatedParams.id, { fileId: file_id, name });
  return res.json({ data: toAuthoredFunction(fn) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
