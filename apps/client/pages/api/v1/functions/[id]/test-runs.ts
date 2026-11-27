import { runFunctionTestsContract } from '@bike4mind/common';
import { runCallableFunctionTests } from '@bike4mind/server-utils/callableFunctions/testRun';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled, functionsRateLimit } from '@server/callableFunctions/publicFunctions';
import { toTestRun } from '@server/callableFunctions/authoredFunctions';

const handler = nextRouteForContract(runFunctionTestsContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/test-runs'),
}).post(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { tests } = req.validated;
  const run = await runCallableFunctionTests(req.user, req.validatedParams.id, tests ? { tests } : {});
  return res.json({ data: toTestRun(run) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
