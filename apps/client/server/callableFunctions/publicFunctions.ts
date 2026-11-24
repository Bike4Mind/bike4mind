import {
  ForbiddenError,
  NotFoundError,
  REQUEST_TIMEOUT_ERROR_CODE,
  projectFunctionSchema,
  type FunctionContractProblem,
  type ICallableFunctionDetail,
  type ICallableFunctionPublic,
} from '@bike4mind/common';
import { callableFunctionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { resolveCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { getCallableFunction, listCallableFunctions } from '@bike4mind/server-utils/callableFunctions/registry';
import {
  CALLABLE_FUNCTION_SURFACE_CAPS,
  type DispatchFunctionCallResult,
} from '@bike4mind/server-utils/callableFunctions/dispatch';
import { CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS } from '@bike4mind/server-utils/callableFunctions/runtimeParent';

/*
 * Pieces the public /api/v1/functions routes share. Only the key owner's live functions are reachable: a draft, a
 * turned-off function, a deleted source, another person's function, and a missing one all throw the same 404.
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

/** The input cap plus room for the `{ "input": ... }` envelope and a pretty-printed body. */
export const FUNCTION_INVOKE_MAX_BODY_BYTES = CALLABLE_FUNCTION_SURFACE_CAPS.rest.inputBytes + 64 * 1024;

export const FUNCTION_NOT_FOUND_MESSAGE = 'Function not found';

const notFound = () => new NotFoundError(FUNCTION_NOT_FOUND_MESSAGE);

export async function assertFunctionsEnabled(user: { id: string }): Promise<void> {
  if (!(await resolveCallableFunctionsEnabled(user))) {
    throw new ForbiddenError('Callable functions are turned off for this account.');
  }
}

/** The owner's live function, or the one 404 every other case shares. */
export async function loadLiveFunction(user: { id: string }, id: string): Promise<ICallableFunctionDetail> {
  let fn: ICallableFunctionDetail;
  try {
    fn = await getCallableFunction(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound();
    throw error;
  }
  if (fn.status !== 'live') throw notFound();
  return fn;
}

/** The owner's live function holding `slug`: one slug read, then the same live check as `loadLiveFunction`. */
export async function loadLiveFunctionBySlug(user: { id: string }, slug: string): Promise<ICallableFunctionDetail> {
  const found = await callableFunctionRepository.findBySlugForOwner(slug, { ownerType: 'user', ownerKey: user.id });
  if (!found) throw notFound();
  return loadLiveFunction(user, found.id);
}

export async function listLiveFunctions(user: { id: string }): Promise<ICallableFunctionPublic[]> {
  return (await listCallableFunctions(user)).filter(fn => fn.status === 'live');
}

export function toPublicFunction(fn: ICallableFunctionPublic) {
  return {
    id: fn.id,
    slug: fn.slug,
    description: fn.description,
    trust_label: fn.trustLabel,
    pin_version: fn.pin.version,
    pin_seq: fn.pin.seq ?? null,
    updated_at: new Date(fn.updatedAt).toISOString(),
  };
}

export function toPublicFunctionDetail(fn: ICallableFunctionDetail) {
  const rest = projectFunctionSchema(fn.contract, 'rest');
  return { ...toPublicFunction(fn), input_schema: rest.inputs, output_schema: rest.outputs };
}

/** One sentence naming the first field that does not fit, and how many more do not. */
export function describeInputProblems(problems: FunctionContractProblem[]): string {
  const [first] = problems;
  if (!first) return 'The input does not fit the input schema.';
  const field = first.path ? `Input ${first.path}` : 'The input';
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
  return `${field} ${first.message}${more}.`;
}

export interface InvokeAnswer {
  status: number;
  body: Record<string, unknown>;
}

const TIMEOUT_MESSAGE = 'The call ran past its time limit.';

const FUNCTION_RUNTIME_FAULT_MESSAGE = 'The function runtime did not answer. Try again later.';

// Refusals about the function or its caller; any other refusal comes from the runtime.
const FUNCTION_NOT_FOUND_REASONS = new Set(['not_found', 'not_caller', 'disabled', 'source_deleted']);

const errorMessage = (errorClass?: string) => `The function raised an error${errorClass ? ` (${errorClass})` : ''}.`;

const FAILURE_MESSAGES: Record<string, string> = {
  memory: 'The function ran out of memory.',
  output_invalid: 'The function returned outputs that do not fit its output schema.',
  output_too_large: 'The function returned more than a call can carry.',
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
    case 'refused':
      if (call.reason === 'setting_off') {
        return { status: 403, body: { error: 'Callable functions are turned off for this account.' } };
      }
      if (call.reason === 'runtime_unavailable') {
        return { status: 503, body: { error: 'No function runtime is available.' } };
      }
      if (call.reason && FUNCTION_NOT_FOUND_REASONS.has(call.reason)) {
        return { status: 404, body: { error: FUNCTION_NOT_FOUND_MESSAGE } };
      }
      return { status: 503, body: { error: FUNCTION_RUNTIME_FAULT_MESSAGE } };
    case 'error':
      // A runner that threw, never replied, or was slow to start is a platform fault, not the function's own error.
      if (call.reason === 'runtime_unavailable' || call.reason === 'no_reply' || call.reason === 'start_timeout') {
        return { status: 503, body: { error: FUNCTION_RUNTIME_FAULT_MESSAGE } };
      }
      return { status: 502, body: { error: errorMessage(call.errorClass), outcome: call.outcome, ...stamp } };
    default:
      return {
        status: 502,
        body: { error: FAILURE_MESSAGES[call.outcome] ?? 'The function failed.', outcome: call.outcome, ...stamp },
      };
  }
}
