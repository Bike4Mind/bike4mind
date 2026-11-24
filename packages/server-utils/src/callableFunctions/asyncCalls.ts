import type { CallableFunctionCallOutcome, ICallableFunctionResultDocument } from '@bike4mind/common';
import { callableFunctionCallRepository, callableFunctionResultRepository } from '@bike4mind/database';
import {
  dispatchFunctionCall,
  type CallableFunctionCaller,
  type DispatchFunctionCallRequest,
  type DispatchFunctionCallResult,
} from './dispatch';
import { CALLABLE_FUNCTION_PARENT_MARGIN_MS, CALLABLE_FUNCTION_START_BUDGET_MS } from './runtimeParent';
import type { CallableFunctionRunner } from './runtimeRunner';
import { resolveCallableFunctionTimeLimitMs } from './timeLimit';

/**
 * Asynchronous calls: the API queues one after the dispatcher's checks, the worker in
 * apps/workers/src/queueHandlers/callableFunctionCall.ts runs it, and the caller polls the result document.
 */

/** The one message a queued call puts on `callableFunctionCallQueue`; the inputs wait in the result document. */
export interface CallableFunctionCallJob {
  callId: string;
}

/** The consumer Lambda's own timeout, in seconds (infra/queues.ts). */
export const CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS = 900;

/** Room the consumer keeps for its database reads and writes around the run. */
const CONSUMER_MARGIN_MS = 30_000;

/** A queued call's longest time limit: what fits in the consumer with the runtime's start budget and margin. */
export const CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS =
  CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS * 1000 -
  CALLABLE_FUNCTION_START_BUDGET_MS -
  CALLABLE_FUNCTION_PARENT_MARGIN_MS -
  CONSUMER_MARGIN_MS;

/**
 * Makes every check a synchronous call makes, then writes the row as `queued`, keeps the inputs in a result
 * document, and sends one job. A refusal comes back as the dispatcher's result and nothing is queued.
 */
export async function queueFunctionCall(
  request: DispatchFunctionCallRequest & { args: Record<string, unknown> },
  options: { send: (job: CallableFunctionCallJob) => Promise<unknown>; runner?: CallableFunctionRunner | null }
): Promise<DispatchFunctionCallResult> {
  return dispatchFunctionCall(request, {
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
    enqueue: async callId => {
      await callableFunctionResultRepository.createQueued({
        callId,
        callerUserId: request.caller.id,
        functionId: request.functionId,
        ...(request.apiKeyId ? { apiKeyId: request.apiKeyId } : {}),
        input: request.args,
      });
      try {
        await options.send({ callId });
      } catch (error) {
        await callableFunctionResultRepository.finish(callId, { outcome: 'error', reason: 'queue_failed' });
        throw error;
      }
    },
  });
}

/**
 * Runs one queued call under the caller's time limit, once: a redelivered job finds it claimed and is skipped.
 * The dispatcher checks everything again, so a function turned off while the call waited is refused.
 */
export async function runQueuedFunctionCall(
  job: CallableFunctionCallJob,
  options: { runner?: CallableFunctionRunner | null } = {}
): Promise<DispatchFunctionCallResult<CallableFunctionCallOutcome> | null> {
  const claimed = await callableFunctionResultRepository.claim(job.callId);
  if (!claimed) return null;
  try {
    await callableFunctionCallRepository.rewrite(job.callId, { outcome: 'running' });
    const limitMs = await resolveCallableFunctionTimeLimitMs({ id: claimed.callerUserId });
    const call = await dispatchFunctionCall(
      {
        caller: { id: claimed.callerUserId },
        functionId: claimed.functionId,
        args: claimed.input ?? {},
        surface: 'rest',
        ...(claimed.apiKeyId ? { apiKeyId: claimed.apiKeyId } : {}),
      },
      {
        ...(options.runner !== undefined ? { runner: options.runner } : {}),
        timeoutMs: Math.min(limitMs, CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS),
        callId: job.callId,
      }
    );
    await callableFunctionResultRepository.finish(job.callId, {
      outcome: call.outcome,
      ...(call.reason ? { reason: call.reason } : {}),
      ...(call.errorClass ? { errorClass: call.errorClass } : {}),
      ...(call.problems ? { problems: call.problems } : {}),
      ...(call.outputs ? { outputs: call.outputs } : {}),
      ...(call.stamp ? { stamp: call.stamp } : {}),
    });
    return call;
  } catch (error) {
    // Not retried: a second delivery could run the guest twice.
    await callableFunctionCallRepository.rewrite(job.callId, { outcome: 'error', reason: 'dispatch_failed' });
    await callableFunctionResultRepository.finish(job.callId, { outcome: 'error', reason: 'dispatch_failed' });
    throw error;
  }
}

/** The caller's own call while its result is kept; another person's id reads as a missing one. */
export async function readFunctionCall(
  caller: Pick<CallableFunctionCaller, 'id'>,
  callId: string
): Promise<ICallableFunctionResultDocument | null> {
  if (!/^[0-9a-f]{24}$/.test(callId)) return null;
  return callableFunctionResultRepository.findForCaller(callId, caller.id);
}
