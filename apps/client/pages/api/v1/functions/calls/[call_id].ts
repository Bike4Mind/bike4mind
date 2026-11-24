/**
 * GET /api/v1/functions/calls/{call_id} - poll an asynchronous call (`getFunctionCallContract`). Only the caller reads
 * it: another person's call, an expired one, and a made-up id share one 404.
 */
import { NotFoundError, getFunctionCallContract } from '@bike4mind/common';
import { readFunctionCall } from '@bike4mind/server-utils/callableFunctions/asyncCalls';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  FUNCTION_CALL_NOT_FOUND_MESSAGE,
  assertFunctionsEnabled,
  functionCallAnswer,
  functionsRateLimit,
} from '@server/callableFunctions/publicFunctions';

const handler = nextRouteForContract(getFunctionCallContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/calls/[call_id]'),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const call = await readFunctionCall(req.user, req.validatedParams.call_id);
  if (!call) throw new NotFoundError(FUNCTION_CALL_NOT_FOUND_MESSAGE);
  return res.json(functionCallAnswer(call));
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
