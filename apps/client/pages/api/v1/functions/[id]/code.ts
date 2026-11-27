import { saveFunctionCodeContract } from '@bike4mind/common';
import { saveCallableFunctionCode } from '@bike4mind/server-utils/callableFunctions/authoring';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toAuthoredFunctionDetail } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(saveFunctionCodeContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/code'),
}).put(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { code, contract, pin_version } = req.validated;
  const saved = await saveCallableFunctionCode(req.user, req.validatedParams.id, {
    code,
    contract,
    pinVersion: pin_version,
  });
  return res.json({ data: toAuthoredFunctionDetail(saved) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
