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
  type CallableFunctionReason,
  type CallableFunctionRunPayload,
  type CallableFunctionRunResult,
} from './runtimeParent';
import { selectCallableFunctionRunner, type CallableFunctionRunner } from './runtimeRunner';

/**
 * The one way a saved function runs: every surface (the test run now; REST, chat, agent runs, and MCP later) calls
 * `dispatchFunctionCall`, which checks, runs, stamps, and writes one `callablefunctioncalls` row per call or refusal.
 */

/**
 * Codes the dispatcher adds: its refusals before the runtime sees the call, `wait_exceeded` when the runner did not
 * answer within the wait, and `dispatch_failed` when a step threw.
 */
export type CallableFunctionDispatchReason =
  | 'setting_off'
  | 'not_found'
  | 'not_caller'
  | 'disabled'
  | 'source_deleted'
  | 'input_too_large'
  | 'wait_exceeded'
  | 'dispatch_failed';

export type CallableFunctionCallReason = CallableFunctionReason | CallableFunctionDispatchReason;

const MIB = 1024 * 1024;

/**
 * Per surface: input and output caps (5 MB is the runtime's ceiling; results that go into a model's context get
 * 256 KB) and the longest the dispatcher waits for one run. Every surface answers synchronously within the web
 * function's 60 s (`infra/web.ts`), so no wait passes 45 s.
 */
export const CALLABLE_FUNCTION_SURFACE_CAPS: Record<
  CallableFunctionCallSurface,
  { inputBytes: number; outputBytes: number; waitMs: number }
> = {
  test: { inputBytes: 5 * MIB, outputBytes: 5 * MIB, waitMs: 45_000 },
  rest: { inputBytes: 5 * MIB, outputBytes: 5 * MIB, waitMs: 45_000 },
  mcp: { inputBytes: 5 * MIB, outputBytes: 5 * MIB, waitMs: 45_000 },
  chat: { inputBytes: 5 * MIB, outputBytes: 256 * 1024, waitMs: 45_000 },
  agent: { inputBytes: 5 * MIB, outputBytes: 256 * 1024, waitMs: 45_000 },
};

/** A contract read runs the module's top level only, so it gets far less time than a call. */
export const CALLABLE_FUNCTION_CONTRACT_READ_TIMEOUT_MS = 10_000;

/** The longest wait for a contract read: its time limit plus a warm start. A cold runtime does not fit. */
export const CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS = 15_000;

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
  /** What is left of the caller's own budget; the wait never passes the surface's cap either way. */
  waitMs?: number;
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

type RunResult = Omit<CallableFunctionRunResult, 'reason'> & { reason?: CallableFunctionCallReason };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** sha256 of the canonical JSON, so key order never changes it. */
export const functionInputHash = (inputs: unknown): string =>
  createHash('sha256').update(canonicalJson(inputs), 'utf8').digest('hex');

export function buildCallableFunctionStamp(input: {
  fn: Pick<ICallableFunctionDocument, 'id' | 'slug' | 'pin'>;
  inputHash: string;
  run: Pick<CallableFunctionRunResult, 'runtime' | 'durationMs'>;
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

/** The wait for one run: what the caller has left, never more than the surface allows. */
const waitFor = (surface: CallableFunctionCallSurface, waitMs?: number) =>
  Math.max(0, Math.floor(Math.min(waitMs ?? Infinity, CALLABLE_FUNCTION_SURFACE_CAPS[surface].waitMs)));

/** A time limit the runtime accepts: whole, at least 1 ms, and never longer than the wait. */
const limitWithin = (timeoutMs: number, waitMs: number) => Math.max(1, Math.floor(Math.min(timeoutMs, waitMs)));

/** Runs one payload; a runner that throws or does not answer within the wait reads as an outcome, never a hang. */
async function runWithin(
  runner: CallableFunctionRunner,
  payload: CallableFunctionRunPayload,
  waitMs: number
): Promise<RunResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RunResult>(resolve => {
    timer = setTimeout(
      () => resolve({ outcome: 'timeout', reason: 'wait_exceeded', durationMs: Date.now() - started }),
      waitMs
    );
  });
  try {
    return await Promise.race([
      runner(payload).catch((): RunResult => ({
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

type RowFields = Pick<ICallableFunctionCall, 'durationMs' | 'outcome'> &
  Partial<Pick<ICallableFunctionCall, 'reason' | 'errorClass'>>;

/**
 * Runs `body` with a writer for its one call-log row. A failed write is tried once more and then thrown; any other
 * throw before the row is written writes one `error` row with `dispatch_failed`, and the throw goes on.
 */
async function withCallRow<T>(
  row: ICallableFunctionCall,
  body: (write: (fields: RowFields) => Promise<{ id: string }>) => Promise<T>
): Promise<T> {
  let written = false;
  const write = async (fields: RowFields) => {
    written = true;
    const doc: ICallableFunctionCall = { ...row, ...fields };
    try {
      return await callableFunctionCallRepository.record(doc);
    } catch {
      return callableFunctionCallRepository.record(doc);
    }
  };
  try {
    return await body(write);
  } catch (error) {
    if (!written) {
      await write({ durationMs: Date.now() - row.startedAt.getTime(), outcome: 'error', reason: 'dispatch_failed' });
    }
    throw error;
  }
}

const runtimeRow = (run: Pick<CallableFunctionRunResult, 'runtime'>): ICallableFunctionCall['runtime'] => ({
  kind: RUNTIME_KIND,
  version: PYODIDE_VERSION,
  ...(run.runtime ? { lockHash: run.runtime.lockHash } : {}),
});

export type ServerContractRead =
  | { ok: true; contract: FunctionContract; callId: string }
  | {
      ok: false;
      outcome: CallableFunctionCallOutcome;
      reason?: CallableFunctionCallReason;
      problems?: FunctionContractProblem[];
      callId: string;
    };

/**
 * Reads `FUNCTION` from the pinned code through the runtime, so the server never trusts a browser's read. It runs
 * the pinned code, so it writes one call-log row with `op: 'read_contract'` and no input hash or sizes. The caller
 * has already checked the setting, the owner, and the status.
 */
export async function readServerContract(
  request: {
    caller: CallableFunctionCaller;
    fn: Pick<ICallableFunctionDocument, 'id' | 'userId' | 'pin'>;
    surface: CallableFunctionCallSurface;
  },
  options: { runner: CallableFunctionRunner; waitMs?: number }
): Promise<ServerContractRead> {
  const { caller, fn, surface } = request;
  const row: ICallableFunctionCall = {
    op: 'read_contract',
    functionId: fn.id,
    ownerUserId: fn.userId,
    callerUserId: caller.id,
    ...(caller.organizationId ? { organizationId: caller.organizationId } : {}),
    surface,
    codeHash: fn.pin.contentHash,
    dataHashes: [],
    startedAt: new Date(),
    durationMs: 0,
    outcome: 'refused',
  };
  return withCallRow(row, async write => {
    const waitMs = Math.min(waitFor(surface, options.waitMs), CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS);
    const timeoutMs = limitWithin(CALLABLE_FUNCTION_CONTRACT_READ_TIMEOUT_MS, waitMs);
    const run = await runWithin(
      options.runner,
      { op: 'read_contract', code: fn.pin.source, limits: { timeoutMs } },
      waitMs
    );
    row.runtime = runtimeRow(run);
    if (run.initMs !== undefined) row.initMs = run.initMs;
    const saved = await write({
      durationMs: run.durationMs,
      outcome: run.outcome,
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.errorClass ? { errorClass: run.errorClass } : {}),
    });
    if (run.outcome === 'ok' && run.contract) return { ok: true, contract: run.contract, callId: saved.id };
    return {
      ok: false,
      outcome: run.outcome,
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.problems ? { problems: run.problems } : {}),
      callId: saved.id,
    };
  });
}

/** The current version of the pinned artifact while its owner still holds it, as the registry reads it. */
async function readHead(fn: ICallableFunctionDocument) {
  const artifact = await artifactRepository.findOne({ id: fn.pin.artifactId, userId: fn.userId });
  return artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null;
}

/**
 * Checks, in order, the setting, the record, the caller (the owner only), the status, the input size, and the
 * inputs, then runs the pinned code, checks the outputs, and stamps the result. Every path, a throw included, writes
 * one call-log row with hashes and sizes only. Another owner's function answers `not_found`, as a missing one does;
 * only the row says `not_caller`.
 */
export async function dispatchFunctionCall(
  request: DispatchFunctionCallRequest,
  options: CallableFunctionDispatchOptions = {}
): Promise<DispatchFunctionCallResult> {
  const { caller, functionId, args, surface, apiKeyId } = request;
  const startedAt = new Date();
  const row: ICallableFunctionCall = {
    op: 'call',
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

  return withCallRow(row, async write => {
    const finish = async (
      result: Omit<DispatchFunctionCallResult, 'callId' | 'durationMs'> & { durationMs?: number },
      rowReason: CallableFunctionCallReason | undefined = result.reason
    ): Promise<DispatchFunctionCallResult> => {
      const durationMs = result.durationMs ?? Date.now() - startedAt.getTime();
      const saved = await write({
        durationMs,
        outcome: result.outcome,
        ...(rowReason ? { reason: rowReason } : {}),
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

    if (fn.ownerType !== 'user' || fn.ownerKey !== caller.id) {
      return finish({ outcome: 'refused', reason: 'not_found' }, 'not_caller');
    }

    const status = effectiveCallableFunctionStatus(fn, await readHead(fn));
    if (status === 'disabled' || status === 'source_deleted') return refuse(status);

    // Measured before validation, so an input of any size is never walked.
    const caps = CALLABLE_FUNCTION_SURFACE_CAPS[surface];
    row.inputBytes = functionJsonBytes(JSON.stringify(args) ?? '');
    if (row.inputBytes > Math.min(caps.inputBytes, CALLABLE_FUNCTION_LIMITS.inputBytes)) {
      return finish({ outcome: 'input_invalid', reason: 'input_too_large' });
    }

    const contract = options.contract ?? fn.contract;
    if (isObject(args)) row.inputHash = functionInputHash(args);
    const problems = validateFunctionValue(contract.inputs, args);
    if (problems.length > 0) return finish({ outcome: 'input_invalid', problems });

    const runner = options.runner === undefined ? selectCallableFunctionRunner() : options.runner;
    if (!runner) return finish({ outcome: 'refused', reason: 'runtime_unavailable' });
    const params = args as Record<string, unknown>;
    const inputHash = row.inputHash ?? functionInputHash(params);
    const waitMs = waitFor(surface, options.waitMs);
    const timeoutMs = limitWithin(options.timeoutMs ?? CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS, waitMs);
    const outputBytesCap = Math.min(caps.outputBytes, CALLABLE_FUNCTION_LIMITS.outputBytes);
    const run = await runWithin(
      runner,
      { op: 'call', code: fn.pin.source, contract, params, limits: { timeoutMs, outputBytes: outputBytesCap } },
      waitMs
    );
    row.runtime = runtimeRow(run);
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
  });
}
