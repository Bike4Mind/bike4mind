/**
 * POST /api/v1/functions/calls/{call_id}/cancel - cancel an asynchronous call (`cancelFunctionCallContract`). Only
 * the caller cancels it: another person's call, an expired one, and a made-up id share one 404.
 */
import { NotFoundError, cancelFunctionCallContract } from '@bike4mind/common';
import { cancelFunctionCall } from '@bike4mind/server-utils/callableFunctions/asyncCalls';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  FUNCTION_CALL_NOT_FOUND_MESSAGE,
  assertFunctionsEnabled,
  functionCallAnswer,
  functionsRateLimit,
} from '@server/callableFunctions/publicFunctions';

const handler = nextRouteForContract(cancelFunctionCallContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/calls/[call_id]/cancel'),
}).post(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const call = await cancelFunctionCall(req.user, req.validatedParams.call_id);
  if (!call) throw new NotFoundError(FUNCTION_CALL_NOT_FOUND_MESSAGE);
  return res.json(functionCallAnswer(call));
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
