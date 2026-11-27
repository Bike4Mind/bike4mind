import {
  CONCURRENCY_LIMIT_EXCEEDED_ERROR_CODE,
  TooManyRequestsError,
  type CallableFunctionCallOutcome,
  type ICallableFunctionResultDocument,
} from '@bike4mind/common';
import { callableFunctionCallRepository, callableFunctionResultRepository } from '@bike4mind/database';
import {
  dispatchFunctionCall,
  type CallableFunctionCaller,
  type DispatchFunctionCallRequest,
  type DispatchFunctionCallResult,
} from './dispatch';
import {
  CALLABLE_FUNCTION_CALL_CONSUMER_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_CALL_QUEUE_MAX_RECEIVES,
  CALLABLE_FUNCTION_CALL_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS,
} from './runtimeParent';
import type { CallableFunctionRunner } from './runtimeRunner';
import { resolveCallableFunctionPendingCallLimit, resolveCallableFunctionTimeLimitMs } from './timeLimit';

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
 * A job still unclaimed this long after it was queued has used every receive the queue allows, so it is on the
 * dead-letter queue and nothing will run it.
 */
export const UNCLAIMED_AFTER_MS =
  CALLABLE_FUNCTION_CALL_QUEUE_VISIBILITY_TIMEOUT_SECONDS * CALLABLE_FUNCTION_CALL_QUEUE_MAX_RECEIVES * 1000;

const pendingSince = (now = Date.now()) => ({
  queuedSince: new Date(now - UNCLAIMED_AFTER_MS),
  runningSince: new Date(now - LOST_WORKER_AFTER_MS),
});

/**
 * Makes every check a synchronous call makes, then writes the row as `queued`, keeps the inputs in a result
 * document, and sends one job. A refusal comes back as the dispatcher's result and nothing is queued. A caller
 * already at `CallableFunctionPendingCallLimit` queued or running calls is refused with a 429 first.
 */
export async function queueFunctionCall(
  request: DispatchFunctionCallRequest & { args: Record<string, unknown> },
  options: { send: (job: CallableFunctionCallJob) => Promise<unknown>; runner?: CallableFunctionRunner | null }
): Promise<DispatchFunctionCallResult> {
  const limit = await resolveCallableFunctionPendingCallLimit(request.caller);
  if ((await callableFunctionResultRepository.countPending(request.caller.id, pendingSince())) >= limit) {
    throw new TooManyRequestsError(
      `At most ${limit} asynchronous calls may be queued or running at once. Send this one when one finishes.`,
      { errorCode: CONCURRENCY_LIMIT_EXCEEDED_ERROR_CODE, limit }
    );
  }
  return dispatchFunctionCall(request, {
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
    enqueue: async callId => {
      await callableFunctionResultRepository.createQueued({
        callId,
        callerUserId: request.caller.id,
        functionId: request.functionId,
        ...(request.apiKeyId ? { apiKeyId: request.apiKeyId } : {}),
        ...(request.caller.organizationId ? { organizationId: request.caller.organizationId } : {}),
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
 * Runs one queued call under the caller's time limit, once. A redelivery skips a claimed call, and settles one
 * whose worker is gone as `worker_lost`. The dispatcher checks everything again before it runs. Null when the call
 * was not run here, or was cancelled while it ran.
 */
export async function runQueuedFunctionCall(
  job: CallableFunctionCallJob,
  options: { runner?: CallableFunctionRunner | null } = {}
): Promise<DispatchFunctionCallResult<CallableFunctionCallOutcome> | null> {
  const claimed = await callableFunctionResultRepository.claim(job.callId);
  if (!claimed) {
    const staleBefore = new Date(Date.now() - LOST_WORKER_AFTER_MS);
    // True also when an earlier delivery already ended the result but died before it rewrote the row.
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
        caller: {
          id: claimed.callerUserId,
          ...(claimed.organizationId ? { organizationId: claimed.organizationId } : {}),
        },
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
    const stored = await callableFunctionResultRepository.finish(job.callId, {
      outcome: call.outcome,
      ...(call.reason ? { reason: call.reason } : {}),
      ...(call.errorClass ? { errorClass: call.errorClass } : {}),
      ...(call.problems ? { problems: call.problems } : {}),
      ...(call.outputs ? { outputs: call.outputs } : {}),
      ...(call.stamp ? { stamp: call.stamp } : {}),
    });
    return stored === 'cancelled' ? null : call;
  } catch (error) {
    // Not retried: a second delivery could run the guest twice.
    await callableFunctionCallRepository.rewrite(job.callId, { outcome: 'error', reason: 'dispatch_failed' });
    await callableFunctionResultRepository.finish(job.callId, { outcome: 'error', reason: 'dispatch_failed' });
    throw error;
  }
}

/**
 * The caller's own call while its result is kept; another person's id reads as a missing one. A call still
 * `queued` past every receive is ended `error`/`worker_lost` here, the one place that sees it.
 */
export async function readFunctionCall(
  caller: Pick<CallableFunctionCaller, 'id'>,
  callId: string
): Promise<ICallableFunctionResultDocument | null> {
  if (!/^[0-9a-f]{24}$/.test(callId)) return null;
  const call = await callableFunctionResultRepository.findForCaller(callId, caller.id);
  if (call?.state !== 'queued') return call;
  const { queuedSince } = pendingSince();
  if (call.createdAt >= queuedSince) return call;
  if (await callableFunctionResultRepository.endUnclaimed(callId, queuedSince)) {
    await callableFunctionCallRepository.rewrite(callId, { outcome: 'error', reason: 'worker_lost' });
  }
  return callableFunctionResultRepository.findForCaller(callId, caller.id);
}

/**
 * Cancels the caller's own call while it is `queued` or `running`, result and row both; a run still going ends
 * without storing anything. Returns the call as it stands, unchanged once finished; another person's id reads as a
 * missing one.
 */
export async function cancelFunctionCall(
  caller: Pick<CallableFunctionCaller, 'id'>,
  callId: string
): Promise<ICallableFunctionResultDocument | null> {
  if (!/^[0-9a-f]{24}$/.test(callId)) return null;
  const cancelled = await callableFunctionResultRepository.cancel(callId, caller.id);
  if (!cancelled) return readFunctionCall(caller, callId);
  await callableFunctionCallRepository.rewrite(callId, { outcome: 'cancelled' });
  return cancelled;
}
