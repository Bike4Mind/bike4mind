import type { CallableFunctionCallOutcome, ICallableFunctionResultDocument } from '@bike4mind/common';
import { callableFunctionCallRepository, callableFunctionResultRepository } from '@bike4mind/database';
import {
  dispatchFunctionCall,
  type CallableFunctionCaller,
  type DispatchFunctionCallRequest,
  type DispatchFunctionCallResult,
} from './dispatch';
import {
  CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS,
} from './runtimeParent';
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

/** A worker that has held a call `running` this long is gone: the consumer's own timeout is this many seconds. */
const LOST_WORKER_AFTER_MS = CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS * 1000;

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
 * Runs one queued call under the caller's time limit, once: a redelivered job finds it claimed and is skipped,
 * and ends it as `worker_lost` if its worker has held it `running` past the consumer's timeout.
 * The dispatcher checks everything again, so a function turned off while the call waited is refused.
 */
export async function runQueuedFunctionCall(
  job: CallableFunctionCallJob,
  options: { runner?: CallableFunctionRunner | null } = {}
): Promise<DispatchFunctionCallResult<CallableFunctionCallOutcome> | null> {
  const claimed = await callableFunctionResultRepository.claim(job.callId);
  if (!claimed) {
    const staleBefore = new Date(Date.now() - LOST_WORKER_AFTER_MS);
    if (await callableFunctionResultRepository.endLost(job.callId, staleBefore)) {
      await callableFunctionCallRepository.rewrite(job.callId, { outcome: 'error', reason: 'worker_lost' });
    }
    return null;
  }
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
