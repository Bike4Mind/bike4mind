import {
  FUNCTION_REVIEW_REQUIRED_ERROR_CODE,
  ForbiddenError,
  NotFoundError,
  REQUEST_TIMEOUT_ERROR_CODE,
  projectFunctionSchema,
  shownCallableFunctionTrustLabel,
  type CallableFunctionAccess,
  type CallableFunctionSharedStatus,
  type FunctionContractProblem,
  type ICallableFunctionResult,
  type PublicFunctionGroup,
  type PublicFunctionReviewStatus,
} from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { resolveCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  findCallerFunction,
  listCallerFunctions,
  type CallerFunction,
} from '@bike4mind/server-utils/callableFunctions/callerFunctions';
import { displayNamesOf } from '@bike4mind/server-utils/callableFunctions/sharing';
import {
  CALLABLE_FUNCTION_SURFACE_CAPS,
  type DispatchFunctionCallResult,
} from '@bike4mind/server-utils/callableFunctions/dispatch';
import { CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS } from '@bike4mind/server-utils/callableFunctions/runtimeParent';

/*
 * Pieces the public /api/v1/functions routes share. A key reaches its owner's live functions and those shared with
 * them (`callerFunctions`): a draft, a turned-off function, a deleted source, a function out of reach, and a missing
 * one all throw the same 404.
 */

export const functionsRateLimit = (bucket: string) =>
  rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user, req),
    windowMs: 60 * 1000,
    bucket,
  });

/** The whole call, from the request's arrival, ends within the rest surface's wait, inside the web function's 60 s. */
export const FUNCTION_INVOKE_BUDGET_MS = CALLABLE_FUNCTION_SURFACE_CAPS.rest.waitMs;

/** The guest's own run time; the runtime's start and its margin sit outside it. */
export const FUNCTION_INVOKE_RUN_TIMEOUT_MS = Math.min(CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS, FUNCTION_INVOKE_BUDGET_MS);

/** Said only when the organization's limit is longer than a synchronous call can wait. */
export const FUNCTION_SYNC_STOP_MESSAGE =
  'A synchronous call stops at 45 s. Send "mode": "async" to run to your time limit, then poll the call for its result.';

/** Said instead on an install without async, where a limit past a synchronous call's wait cannot be reached. */
export const FUNCTION_SYNC_STOP_SELF_HOST_MESSAGE =
  'A synchronous call stops at 45 s, and asynchronous calls are not available on self-hosted installs, so a time limit above 45 s cannot be used here.';

/** The 504 for a synchronous call: it names async mode only when async mode would have let the call run longer. */
export function syncTimeoutError(limitMs: number): string {
  if (limitMs <= FUNCTION_INVOKE_BUDGET_MS) return TIMEOUT_MESSAGE;
  return process.env.B4M_SELF_HOST === 'true' ? FUNCTION_SYNC_STOP_SELF_HOST_MESSAGE : FUNCTION_SYNC_STOP_MESSAGE;
}

export const FUNCTION_CALL_NOT_FOUND_MESSAGE = 'Call not found';

export const FUNCTION_QUEUE_FAILED_MESSAGE = 'The call could not be queued. Try again later.';

export const FUNCTION_ASYNC_UNAVAILABLE_MESSAGE = 'Asynchronous calls are not available on self-hosted installs.';

export const FUNCTION_CALL_STOPPED_MESSAGE = 'The call stopped before it finished. Send it again.';

export const FUNCTION_CALL_CANCELLED_MESSAGE = 'The call was cancelled.';

/** The input cap plus room for the `{ "input": ... }` envelope and a pretty-printed body. */
export const FUNCTION_INVOKE_MAX_BODY_BYTES = CALLABLE_FUNCTION_SURFACE_CAPS.rest.inputBytes + 64 * 1024;

export const FUNCTION_NOT_FOUND_MESSAGE = 'Function not found';

export const FUNCTION_REVIEW_REQUIRED_MESSAGE =
  'This function was shared with you. Review it in Bike4Mind under Integrations before calling it.';

const notFound = () => new NotFoundError(FUNCTION_NOT_FOUND_MESSAGE);

export async function assertFunctionsEnabled(user: { id: string }): Promise<void> {
  if (!(await resolveCallableFunctionsEnabled(user))) {
    throw new ForbiddenError('Callable functions are turned off for this account.');
  }
}

/**
 * A function the caller reaches by access (their own, or one shared with them), even one still awaiting their
 * review, which the dispatcher then refuses; a draft, a missing one, or one out of reach throws the one 404.
 */
export async function resolveCallableFunction(user: { id: string }, id: string): Promise<CallerFunction> {
  const lookup = await findCallerFunction(user, { id });
  if (!('found' in lookup)) throw notFound();
  return lookup.found;
}

/** The functions the caller can call now: their own live ones, then shared ones they have reviewed. */
export async function listLiveFunctions(user: { id: string }): Promise<CallerFunction[]> {
  return listCallerFunctions(user);
}

/** The caller's own live functions, then every live one shared with them, reviewed or not. */
export async function listReachableFunctions(user: { id: string }): Promise<CallerFunction[]> {
  return listCallerFunctions(user, { includeUnreviewed: true });
}

/** Exhaustive, so a new way to reach a function fails to compile here until it is given a group. */
export function publicFunctionGroup(access: CallableFunctionAccess): PublicFunctionGroup {
  switch (access) {
    case 'owner':
      return 'own';
    case 'person':
    case 'project':
    case 'organization':
      return 'shared';
    default: {
      const unmapped: never = access;
      throw new Error(`No group for access ${String(unmapped)}`);
    }
  }
}

const REVIEW_STATUS: Record<CallableFunctionSharedStatus, PublicFunctionReviewStatus> = {
  pending_review: 'needs_review',
  reviewed: 'allowed',
  disabled: 'withdrawn',
};

export function toPublicFunction({ fn, name, access, review }: CallerFunction) {
  return {
    id: fn.id,
    slug: name,
    description: fn.description,
    group: publicFunctionGroup(access),
    review_status: review ? REVIEW_STATUS[review.status] : null,
    trust_label: shownCallableFunctionTrustLabel(fn),
    pin_version: fn.pin.version,
    pin_seq: fn.pin.seq ?? null,
    updated_at: new Date(fn.updatedAt).toISOString(),
  };
}

/** The read and the review answer: the interface a recipient reviews, and who shared it; never code or data. */
export async function toPublicFunctionDetail(entry: CallerFunction) {
  const rest = projectFunctionSchema(entry.fn.contract, 'rest');
  const shared = entry.access !== 'owner';
  const [ownerName] = shared ? await displayNamesOf([entry.fn.userId]) : [];
  return {
    ...toPublicFunction(entry),
    input_schema: rest.inputs,
    output_schema: rest.outputs,
    shared_by: ownerName ? { name: ownerName } : null,
    shared_via: entry.access === 'owner' ? null : entry.access,
    review_hash: entry.review?.hash ?? null,
  };
}

/** One sentence naming the first field that does not fit, and how many more do not. */
export function describeInputProblems(problems: FunctionContractProblem[]): string {
  const [first] = problems;
  if (!first) return 'The input does not fit the input schema.';
  const field = first.path ? `Input ${first.path}` : 'The input';
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return `${field} ${first.message}${more}.`;
}

const OUTPUT_INVALID_MESSAGE = 'The function returned outputs that do not fit its output schema.';

/** The output schema refusal, then the first output field that does not fit and how many more do not. */
export function describeOutputProblems(problems: FunctionContractProblem[]): string {
  const [first] = problems;
  if (!first) return OUTPUT_INVALID_MESSAGE;
  const field = first.path ? `Output ${first.path}` : 'The output';
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return `${OUTPUT_INVALID_MESSAGE} ${field} ${first.message}${more}.`;
}

export interface InvokeAnswer {
  status: number;
  body: Record<string, unknown>;
}

export const TIMEOUT_MESSAGE = 'The call ran past its time limit.';

export const FUNCTION_RUNTIME_FAULT_MESSAGE = 'The function runtime did not answer. Try again later.';

// Refusals about the function or its caller; any other refusal comes from the runtime.
const FUNCTION_NOT_FOUND_REASONS = new Set(['not_found', 'not_caller', 'disabled', 'source_deleted']);

const errorMessage = (errorClass?: string) => `The function raised an error${errorClass ? ` (${errorClass})` : ''}.`;

export const OUTPUT_TOO_LARGE_MESSAGE = 'The function returned more than a call can carry.';

const FAILURE_MESSAGES: Record<string, string> = {
  memory: 'The function ran out of memory.',
  output_too_large: OUTPUT_TOO_LARGE_MESSAGE,
};

/** The HTTP answer for one dispatcher result. Refusals the route did not catch first still map to their status. */
export function invokeAnswer(call: DispatchFunctionCallResult): InvokeAnswer {
  const stamp = call.stamp ? { stamp: call.stamp } : {};
  if (call.outcome === 'refused' && call.reason === 'budget_exhausted') {
    return { status: 504, body: { error: TIMEOUT_MESSAGE, errorCode: REQUEST_TIMEOUT_ERROR_CODE } };
  }
  switch (call.outcome) {
    case 'ok':
      return { status: 200, body: { output: call.outputs ?? {}, stamp: call.stamp } };
    case 'input_invalid':
      if (call.reason === 'input_too_large') {
        return { status: 413, body: { error: 'The input is larger than a call accepts.' } };
      }
      return {
        status: 422,
        body: { error: describeInputProblems(call.problems ?? []), problems: call.problems ?? [] },
      };
    case 'timeout':
      return {
        status: 504,
        body: { error: TIMEOUT_MESSAGE, errorCode: REQUEST_TIMEOUT_ERROR_CODE, ...stamp },
      };
    case 'queued':
      return { status: 202, body: { call_id: call.callId, status: 'queued' } };
    case 'refused':
      if (call.reason === 'setting_off') {
        return { status: 403, body: { error: 'Callable functions are turned off for this account.' } };
      }
      if (call.reason === 'runtime_unavailable') {
        return { status: 503, body: { error: 'No function runtime is available.' } };
      }
      if (call.reason === 'review_required') {
        return {
          status: 403,
          body: { error: FUNCTION_REVIEW_REQUIRED_MESSAGE, errorCode: FUNCTION_REVIEW_REQUIRED_ERROR_CODE },
        };
      }
      if (call.reason && FUNCTION_NOT_FOUND_REASONS.has(call.reason)) {
        return { status: 404, body: { error: FUNCTION_NOT_FOUND_MESSAGE } };
      }
      return { status: 503, body: { error: FUNCTION_RUNTIME_FAULT_MESSAGE } };
    case 'error':
      if (call.reason === 'queue_failed') return { status: 503, body: { error: FUNCTION_QUEUE_FAILED_MESSAGE } };
      // A runner that threw, never replied, or was slow to start is a platform fault, not the function's own error.
      if (call.reason === 'runtime_unavailable' || call.reason === 'no_reply' || call.reason === 'start_timeout') {
        return { status: 503, body: { error: FUNCTION_RUNTIME_FAULT_MESSAGE } };
      }
      return { status: 502, body: { error: errorMessage(call.errorClass), outcome: call.outcome, ...stamp } };
    case 'output_invalid':
      return {
        status: 502,
        // A reason means the contract or the result was unreadable, so its problems are not about output fields.
        body: {
          error: describeOutputProblems(call.reason ? [] : (call.problems ?? [])),
          outcome: call.outcome,
          ...stamp,
        },
      };
    default:
      return {
        status: 502,
        body: { error: FAILURE_MESSAGES[call.outcome] ?? 'The function failed.', outcome: call.outcome, ...stamp },
      };
  }
}

/** A polled call: `queued` and `running` alone, a finished one with its outcome and what the invoke would answer. */
export function functionCallAnswer(doc: ICallableFunctionResult): Record<string, unknown> {
  if (doc.state !== 'finished' || !doc.outcome) return { call_id: doc.callId, status: doc.state };
  const base = { call_id: doc.callId, status: 'finished', outcome: doc.outcome };
  if (doc.outcome === 'ok') return { ...base, output: doc.outputs ?? {}, ...(doc.stamp ? { stamp: doc.stamp } : {}) };
  if (doc.outcome === 'cancelled') return { ...base, error: FUNCTION_CALL_CANCELLED_MESSAGE };
  // These two reasons are written only by the queue worker, so they are not dispatcher reasons.
  if (doc.reason === 'worker_lost' || doc.reason === 'dispatch_failed') {
    return { ...base, error: FUNCTION_CALL_STOPPED_MESSAGE, ...(doc.stamp ? { stamp: doc.stamp } : {}) };
  }
  const answer = invokeAnswer({
    outcome: doc.outcome,
    ...(doc.reason ? { reason: doc.reason as DispatchFunctionCallResult['reason'] } : {}),
    ...(doc.errorClass ? { errorClass: doc.errorClass } : {}),
    ...(doc.problems ? { problems: doc.problems } : {}),
    ...(doc.stamp ? { stamp: doc.stamp } : {}),
    durationMs: doc.stamp?.duration_ms ?? 0,
    callId: doc.callId,
  });
  return {
    ...base,
    error: answer.body.error,
    ...(doc.problems ? { problems: doc.problems } : {}),
    ...(doc.stamp ? { stamp: doc.stamp } : {}),
  };
}
