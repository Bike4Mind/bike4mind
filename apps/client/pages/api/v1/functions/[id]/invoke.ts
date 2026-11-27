/**
 * POST /api/v1/functions/{id}/invoke - run one live function and return `{ output, stamp }` (`invokeFunctionContract`),
 * or with `mode: "async"` queue it and answer 202 with a `call_id` to poll at /api/v1/functions/calls/{call_id}.
 * The key's `functions:invoke` scope is the approval: the owner's own key always runs their live function, and a
 * recipient's key runs a function shared with them once they have reviewed it.
 */
import { invokeFunctionContract } from '@bike4mind/common';
import { dispatchFunctionCall } from '@bike4mind/server-utils/callableFunctions/dispatch';
import { queueFunctionCall } from '@bike4mind/server-utils/callableFunctions/asyncCalls';
import { resolveCallableFunctionTimeLimitMs } from '@bike4mind/server-utils/callableFunctions/timeLimit';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  FUNCTION_INVOKE_BUDGET_MS,
  FUNCTION_ASYNC_UNAVAILABLE_MESSAGE,
  FUNCTION_INVOKE_MAX_BODY_BYTES,
  assertFunctionsEnabled,
  functionsRateLimit,
  invokeAnswer,
  syncTimeoutError,
} from '@server/callableFunctions/publicFunctions';
import { loadLiveFunctionForCall } from '@server/callableFunctions/restRefusals';

const handler = nextRouteForContract(invokeFunctionContract, {
  maxBodySize: FUNCTION_INVOKE_MAX_BODY_BYTES,
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/invoke'),
}).post(async (req, res) => {
  const startedAt = Date.now();
  await assertFunctionsEnabled(req.user);
  const { fn } = await loadLiveFunctionForCall(req.validatedParams.id, {
    user: req.user,
    apiKeyId: req.apiKeyInfo?.keyId,
    logger: req.logger,
  });
  const request = {
    caller: { id: req.user.id },
    functionId: fn.id,
    args: req.validated.input,
    surface: 'rest' as const,
    ...(req.apiKeyInfo?.keyId ? { apiKeyId: req.apiKeyInfo.keyId } : {}),
  };

  if (req.validated.mode === 'async') {
    // Self-host has no queue consumer for these jobs; refuse before the dispatcher writes a row.
    if (process.env.B4M_SELF_HOST === 'true') {
      return res.status(503).json({ error: FUNCTION_ASYNC_UNAVAILABLE_MESSAGE });
    }
    const queued = await queueFunctionCall(request, {
      send: job => sendToQueue(getSourceQueueUrl('callableFunctionCallQueue'), { ...job }),
    });
    const answer = invokeAnswer(queued);
    return res.status(answer.status).json(answer.body);
  }

  const limitMs = await resolveCallableFunctionTimeLimitMs(req.user);
  const call = await dispatchFunctionCall(request, {
    timeoutMs: limitMs,
    deadline: startedAt + FUNCTION_INVOKE_BUDGET_MS,
  });
  const answer = invokeAnswer(call);
  if (answer.status === 504) answer.body.error = syncTimeoutError(limitMs);
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
