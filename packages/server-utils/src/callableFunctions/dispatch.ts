import { createHash } from 'node:crypto';
import {
  PYODIDE_VERSION,
  canonicalJson,
  effectiveCallableFunctionStatus,
  functionJsonBytes,
  validateFunctionValue,
  type CallableFunctionCallOutcome,
  type CallableFunctionCallSurface,
  type FunctionContract,
  type FunctionContractProblem,
  type ICallableFunctionCall,
  type ICallableFunctionDocument,
} from '@bike4mind/common';
import { artifactRepository, callableFunctionCallRepository, callableFunctionRepository } from '@bike4mind/database';
import { resolveCallableFunctionsEnabled } from './access';
import {
  CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS,
  CALLABLE_FUNCTION_LIMITS,
  CALLABLE_FUNCTION_PARENT_MARGIN_MS,
  CALLABLE_FUNCTION_START_BUDGET_MS,
  type CallableFunctionReason,
  type CallableFunctionRunPayload,
  type CallableFunctionRunResult,
} from './runtimeParent';
import { selectCallableFunctionRunner, type CallableFunctionRunner } from './runtimeRunner';

/**
 * The one way a saved function runs: every surface (the test run now; REST, chat, agent runs, and MCP later) calls
 * `dispatchFunctionCall`, which checks, runs, stamps, and writes one `callablefunctioncalls` row per call or refusal.
 */

/** Refusals the dispatcher makes before the runtime sees the call. */
export type CallableFunctionDispatchReason =
  'setting_off' | 'not_found' | 'not_caller' | 'disabled' | 'source_deleted' | 'input_too_large';

export type CallableFunctionCallReason = CallableFunctionReason | CallableFunctionDispatchReason;

const MIB = 1024 * 1024;

/** Input and output caps per surface: 5 MB is the runtime's ceiling; results that go into a model's context get 256 KB. */
export const CALLABLE_FUNCTION_SURFACE_CAPS: Record<
  CallableFunctionCallSurface,
  { inputBytes: number; outputBytes: number }
> = {
  test: { inputBytes: 5 * MIB, outputBytes: 5 * MIB },
  rest: { inputBytes: 5 * MIB, outputBytes: 5 * MIB },
  mcp: { inputBytes: 5 * MIB, outputBytes: 5 * MIB },
  chat: { inputBytes: 5 * MIB, outputBytes: 256 * 1024 },
  agent: { inputBytes: 5 * MIB, outputBytes: 256 * 1024 },
};

/** A contract read runs the module's top level only, so it gets far less time than a call. */
export const CALLABLE_FUNCTION_CONTRACT_READ_TIMEOUT_MS = 10_000;

/** The runtime's own budgets plus its margin: past this the runner has failed to answer, whatever it is doing. */
const hardDeadlineMs = (timeoutMs: number) =>
  timeoutMs + CALLABLE_FUNCTION_START_BUDGET_MS + CALLABLE_FUNCTION_PARENT_MARGIN_MS;

const RUNTIME_KIND = 'pyodide-server';

export interface CallableFunctionCaller {
  id: string;
  organizationId?: string;
}

export interface DispatchFunctionCallRequest {
  caller: CallableFunctionCaller;
  functionId: string;
  args: unknown;
  surface: CallableFunctionCallSurface;
  apiKeyId?: string;
}

export interface CallableFunctionDispatchOptions {
  /** Defaults to the runner the environment selects; null means no runtime is configured. */
  runner?: CallableFunctionRunner | null;
  /** The contract the server read from the pinned code; the record's display copy otherwise. */
  contract?: FunctionContract;
  timeoutMs?: number;
}

/** Room for output hashes beside `data` later; nothing here assumes every output is inline. */
export interface CallableFunctionStamp {
  function_id: string;
  slug: string;
  pin_version: number;
  code_hash: string;
  input_hash: string;
  runtime: { kind: string; version: string; lock_hash: string | null };
  packages: { name: string; version: string }[];
  data: never[];
  uses: never[];
  surface: CallableFunctionCallSurface;
  duration_ms: number;
  called_at: string;
}

export interface DispatchFunctionCallResult {
  outcome: CallableFunctionCallOutcome;
  reason?: CallableFunctionCallReason;
  errorClass?: string;
  problems?: FunctionContractProblem[];
  outputs?: Record<string, unknown>;
  stamp?: CallableFunctionStamp;
  durationMs: number;
  /** The call-log row's id. */
  callId: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** sha256 of the canonical JSON, so key order never changes it. */
export const functionInputHash = (inputs: unknown): string =>
  createHash('sha256').update(canonicalJson(inputs), 'utf8').digest('hex');

export function buildCallableFunctionStamp(input: {
  fn: Pick<ICallableFunctionDocument, 'id' | 'slug' | 'pin'>;
  inputHash: string;
  run: CallableFunctionRunResult;
  surface: CallableFunctionCallSurface;
  calledAt: Date;
}): CallableFunctionStamp {
  const packages = [...(input.run.runtime?.packages ?? [])].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  return {
    function_id: input.fn.id,
    slug: input.fn.slug,
    pin_version: input.fn.pin.version,
    code_hash: input.fn.pin.contentHash,
    input_hash: input.inputHash,
    runtime: { kind: RUNTIME_KIND, version: PYODIDE_VERSION, lock_hash: input.run.runtime?.lockHash ?? null },
    packages,
    data: [],
    uses: [],
    surface: input.surface,
    duration_ms: input.run.durationMs,
    called_at: input.calledAt.toISOString(),
  };
}

/** Runs one payload; a runner that throws or outlives the hard deadline reads as an error, never a hang. */
async function runWithDeadline(
  runner: CallableFunctionRunner,
  payload: CallableFunctionRunPayload,
  timeoutMs: number
): Promise<CallableFunctionRunResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CallableFunctionRunResult>(resolve => {
    timer = setTimeout(
      () => resolve({ outcome: 'error', reason: 'no_reply', durationMs: Date.now() - started }),
      hardDeadlineMs(timeoutMs)
    );
  });
  try {
    return await Promise.race([
      runner(payload).catch((): CallableFunctionRunResult => ({
        outcome: 'error',
        reason: 'runtime_unavailable',
        durationMs: Date.now() - started,
      })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type ServerContractRead =
  | { ok: true; contract: FunctionContract }
  | {
      ok: false;
      outcome: CallableFunctionCallOutcome;
      reason?: CallableFunctionReason;
      problems?: FunctionContractProblem[];
    };

/** Reads `FUNCTION` from the code through the runtime, so the server never trusts a browser's read. */
export async function readServerContract(
  code: string,
  runner: CallableFunctionRunner | null = selectCallableFunctionRunner()
): Promise<ServerContractRead> {
  if (!runner) return { ok: false, outcome: 'refused', reason: 'runtime_unavailable' };
  const timeoutMs = CALLABLE_FUNCTION_CONTRACT_READ_TIMEOUT_MS;
  const result = await runWithDeadline(runner, { op: 'read_contract', code, limits: { timeoutMs } }, timeoutMs);
  if (result.outcome === 'ok' && result.contract) return { ok: true, contract: result.contract };
  return { ok: false, outcome: result.outcome, reason: result.reason, problems: result.problems };
}

/** The current version of the pinned artifact while its owner still holds it, as the registry reads it. */
async function readHead(fn: ICallableFunctionDocument) {
  const artifact = await artifactRepository.findOne({ id: fn.pin.artifactId, userId: fn.userId });
  return artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null;
}

/**
 * Checks, in order, the setting, the record, the caller (the owner only), the status, the inputs, and their size,
 * then runs the pinned code, checks the outputs, and stamps the result. Every path writes one call-log row with
 * hashes and sizes only.
 */
export async function dispatchFunctionCall(
  request: DispatchFunctionCallRequest,
  options: CallableFunctionDispatchOptions = {}
): Promise<DispatchFunctionCallResult> {
  const { caller, functionId, args, surface, apiKeyId } = request;
  const startedAt = new Date();
  const row: ICallableFunctionCall = {
    functionId: functionId.slice(0, 64),
    callerUserId: caller.id,
    ...(apiKeyId ? { apiKeyId } : {}),
    ...(caller.organizationId ? { organizationId: caller.organizationId } : {}),
    surface,
    dataHashes: [],
    startedAt,
    durationMs: 0,
    outcome: 'refused',
  };

  const finish = async (
    result: Omit<DispatchFunctionCallResult, 'callId' | 'durationMs'> & { durationMs?: number }
  ): Promise<DispatchFunctionCallResult> => {
    const durationMs = result.durationMs ?? Date.now() - startedAt.getTime();
    const saved = await callableFunctionCallRepository.record({
      ...row,
      durationMs,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.errorClass ? { errorClass: result.errorClass } : {}),
    });
    return { ...result, durationMs, callId: saved.id };
  };
  const refuse = (reason: CallableFunctionDispatchReason) => finish({ outcome: 'refused', reason });

  if (!(await resolveCallableFunctionsEnabled(caller))) return refuse('setting_off');

  const fn = await callableFunctionRepository.findById(functionId);
  if (!fn) return refuse('not_found');
  row.ownerUserId = fn.userId;
  row.codeHash = fn.pin.contentHash;

  if (fn.ownerType !== 'user' || fn.ownerKey !== caller.id) return refuse('not_caller');

  const status = effectiveCallableFunctionStatus(fn, await readHead(fn));
  if (status === 'disabled' || status === 'source_deleted') return refuse(status);

  const contract = options.contract ?? fn.contract;
  if (isObject(args)) row.inputHash = functionInputHash(args);
  const problems = validateFunctionValue(contract.inputs, args);
  if (problems.length > 0) return finish({ outcome: 'input_invalid', problems });

  const caps = CALLABLE_FUNCTION_SURFACE_CAPS[surface];
  row.inputBytes = functionJsonBytes(JSON.stringify(args));
  if (row.inputBytes > Math.min(caps.inputBytes, CALLABLE_FUNCTION_LIMITS.inputBytes)) {
    return finish({ outcome: 'input_invalid', reason: 'input_too_large' });
  }

  const runner = options.runner === undefined ? selectCallableFunctionRunner() : options.runner;
  if (!runner) return finish({ outcome: 'refused', reason: 'runtime_unavailable' });
  const params = args as Record<string, unknown>;
  const inputHash = row.inputHash ?? functionInputHash(params);
  const timeoutMs = options.timeoutMs ?? CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS;
  const outputBytesCap = Math.min(caps.outputBytes, CALLABLE_FUNCTION_LIMITS.outputBytes);
  const run = await runWithDeadline(
    runner,
    { op: 'call', code: fn.pin.source, contract, params, limits: { timeoutMs, outputBytes: outputBytesCap } },
    timeoutMs
  );
  row.runtime = {
    kind: RUNTIME_KIND,
    version: PYODIDE_VERSION,
    ...(run.runtime ? { lockHash: run.runtime.lockHash } : {}),
  };
  if (run.initMs !== undefined) row.initMs = run.initMs;
  const stamp = buildCallableFunctionStamp({ fn, inputHash, run, surface, calledAt: startedAt });
  const ran = {
    errorClass: run.errorClass,
    problems: run.problems,
    stamp,
    durationMs: run.durationMs,
  };

  if (run.outcome !== 'ok') return finish({ ...ran, outcome: run.outcome, reason: run.reason });

  // The runtime checked these too; a reply from a remote runtime is checked again here.
  const outputs = run.outputs;
  const outputProblems = isObject(outputs) ? validateFunctionValue(contract.outputs, outputs) : [];
  if (!isObject(outputs) || outputProblems.length > 0) {
    return finish({ ...ran, outcome: 'output_invalid', problems: outputProblems });
  }
  row.outputBytes = functionJsonBytes(JSON.stringify(outputs));
  if (row.outputBytes > outputBytesCap) {
    return finish({ ...ran, outcome: 'output_too_large', reason: 'result_too_large' });
  }
  return finish({ ...ran, outcome: 'ok', outputs });
}
