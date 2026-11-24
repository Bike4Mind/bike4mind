/**
 * POST /api/v1/functions/{id}/invoke - run one live function and return `{ output, stamp }` (`invokeFunctionContract`).
 * The key's `functions:invoke` scope is the approval: the owner's own key always runs their live function.
 */
import { invokeFunctionContract } from '@bike4mind/common';
import { dispatchFunctionCall } from '@bike4mind/server-utils/callableFunctions/dispatch';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  FUNCTION_INVOKE_BUDGET_MS,
  FUNCTION_INVOKE_MAX_BODY_BYTES,
  FUNCTION_INVOKE_RUN_TIMEOUT_MS,
  assertFunctionsEnabled,
  functionsRateLimit,
  invokeAnswer,
  loadLiveFunction,
} from '@server/callableFunctions/publicFunctions';

const handler = nextRouteForContract(invokeFunctionContract, {
  maxBodySize: FUNCTION_INVOKE_MAX_BODY_BYTES,
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/invoke'),
}).post(async (req, res) => {
  const startedAt = Date.now();
  await assertFunctionsEnabled(req.user);
  const fn = await loadLiveFunction(req.user, req.validatedParams.id);
  const call = await dispatchFunctionCall(
    {
      caller: { id: req.user.id },
      functionId: fn.id,
      args: req.validated.input,
      surface: 'rest',
      ...(req.apiKeyInfo?.keyId ? { apiKeyId: req.apiKeyInfo.keyId } : {}),
    },
    { timeoutMs: FUNCTION_INVOKE_RUN_TIMEOUT_MS, deadline: startedAt + FUNCTION_INVOKE_BUDGET_MS }
  );
  const answer = invokeAnswer(call);
  return res.status(answer.status).json(answer.body);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
    // Must cover FUNCTION_INVOKE_MAX_BODY_BYTES, which baseApi checks first.
    bodyParser: { sizeLimit: '6mb' },
  },
};
