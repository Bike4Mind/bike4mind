import { createHash } from 'node:crypto';
import {
  PYODIDE_VERSION,
  canonicalJson,
  effectiveCallableFunctionStatus,
  functionJsonBytes,
  recipientCallableFunction,
  shownCallableFunctionTrustLabel,
  validateFunctionValue,
  type CallableFunctionCallOutcome,
  type CallableFunctionCallSurface,
  type CallableFunctionStamp,
  type CallableFunctionStampData,
  type FunctionContract,
  type FunctionContractProblem,
  type ICallableFunctionCall,
  type ICallableFunctionDocument,
  type ICallableFunctionSummary,
} from '@bike4mind/common';
import {
  artifactRepository,
  callableFunctionCallRepository,
  callableFunctionRepository,
  callableFunctionReviewRepository,
  mongoose,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { resolveCallableFunctionsEnabled } from './access';
import {
  callableFunctionDataReachable,
  callableFunctionStampData,
  signCallableFunctionDataEntries,
  signCallableFunctionDataLinks,
  type CallableFunctionDataLink,
} from './dataPins';
import { CALLABLE_FUNCTION_SOURCE_TIMEOUT_MS, CallableFunctionSourceError } from './fetchSource';
import { resolveCallableFunctionSources, type CallableFunctionSourceDeps } from './sources';
import type { CallableFunctionRunData } from './runtimeData';
import {
  CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS,
  CALLABLE_FUNCTION_LIMITS,
  CALLABLE_FUNCTION_PARENT_MARGIN_MS,
  CALLABLE_FUNCTION_START_BUDGET_MS,
  runTimeoutAfterDownload,
  type CallableFunctionReason,
  type CallableFunctionRunPayload,
  type CallableFunctionRunResult,
} from './runtimeParent';
import {
  selectCallableFunctionRunner,
  type CallableFunctionRunner,
  type CallableFunctionTenant,
} from './runtimeRunner';
import { isCurrentReview } from './reviews';
import { canCallFunction } from './sharing';

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
  | 'review_required'
  | 'disabled'
  | 'source_deleted'
  | 'not_live'
  | 'approval_required'
  | 'input_too_large'
  | 'wait_exceeded'
  | 'budget_exhausted'
  | 'source_unavailable'
  | 'dispatch_failed'
  | 'queue_failed';

export type CallableFunctionCallReason = CallableFunctionReason | CallableFunctionDispatchReason;

const MIB = 1024 * 1024;

/**
 * Per surface: input and output caps (5 MB is the runtime's ceiling; results that go into a model's context get
 * 256 KB) and the longest the dispatcher waits for one run. Every surface answers synchronously within the web
 * function's 60 s (`infra/web.ts`), so no wait passes 45 s. An MCP answer carries the output twice, so its cap is
 * 2 MB to leave room in the web function's 6 MB response.
 */
export const CALLABLE_FUNCTION_SURFACE_CAPS: Record<
  CallableFunctionCallSurface,
  { inputBytes: number; outputBytes: number; waitMs: number }
> = {
  test: { inputBytes: 5 * MIB, outputBytes: 5 * MIB, waitMs: 45_000 },
  rest: { inputBytes: 5 * MIB, outputBytes: 5 * MIB, waitMs: 45_000 },
  mcp: { inputBytes: 5 * MIB, outputBytes: 2 * MIB, waitMs: 45_000 },
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
  /** Server-supplied approval for a chat/agent call; omitted is not approved. */
  approved?: boolean;
}

export interface CallableFunctionDispatchOptions {
  /** Defaults to the runner the environment selects; null means no runtime is configured. */
  runner?: CallableFunctionRunner | null;
  /** The contract the server read from the pinned code; the record's display copy otherwise. */
  contract?: FunctionContract;
  timeoutMs?: number;
  /** What is left of the caller's own budget; the wait never passes the surface's cap either way. */
  waitMs?: number;
  /** When the caller's budget ends (epoch ms), so the dispatcher's own reads count against it; wins over `waitMs`. */
  deadline?: number;
  /** Refuses with `budget_exhausted`, without running, when less than this is left once the checks are done. */
  minWaitMs?: number;
  /**
   * Queues the call instead of running it: after every check passes, the row is written as `queued` and this
   * receives its id. A throw marks the row `error` with `queue_failed`.
   */
  enqueue?: (callId: string) => Promise<void>;
  /**
   * Runs a queued call, overwriting its `queued` row rather than writing a second one. It answers no request, so
   * its wait is what the runtime takes for `timeoutMs`, not the surface's synchronous cap.
   */
  callId?: string;
  /** Signs the links for one call's data files; the function-data bucket's signer by default. */
  signData?: (fn: ICallableFunctionDocument) => Promise<CallableFunctionDataLink[]>;
  /** Whether this process can sign data links (`callableFunctionDataReachable` by default). */
  dataReachable?: boolean;
  /** The fetcher, store, origins, and limits for the function's sources; the environment's by default. */
  sources?: CallableFunctionSourceDeps;
}

export type { CallableFunctionStamp };

export interface DispatchFunctionCallResult<
  Outcome extends CallableFunctionCallOutcome | 'queued' = CallableFunctionCallOutcome | 'queued',
> {
  outcome: Outcome;
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
  fn: Pick<ICallableFunctionDocument, 'id' | 'slug' | 'pin' | 'state' | 'trustLabel' | 'platform'>;
  inputHash: string;
  run: Pick<CallableFunctionRunResult, 'runtime' | 'durationMs'>;
  surface: CallableFunctionCallSurface;
  calledAt: Date;
  /** What the call's sources resolved to, after the pinned files. */
  sources?: CallableFunctionStampData[];
}): CallableFunctionStamp {
  const packages = [...(input.run.runtime?.packages ?? [])].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  return {
    function_id: input.fn.id,
    slug: input.fn.slug,
    pin_version: input.fn.pin.version,
    pin_seq: input.fn.pin.seq ?? null,
    code_hash: input.fn.pin.contentHash,
    input_hash: input.inputHash,
    runtime: { kind: RUNTIME_KIND, version: PYODIDE_VERSION, lock_hash: input.run.runtime?.lockHash ?? null },
    packages,
    data: [...callableFunctionStampData(input.fn.pin.dataPins), ...(input.sources ?? [])],
    uses: [],
    trust_label: shownCallableFunctionTrustLabel(input.fn),
    surface: input.surface,
    duration_ms: input.run.durationMs,
    called_at: input.calledAt.toISOString(),
  };
}

/** The wait for one run: what the caller has left, never more than `capMs`. */
const waitFor = (capMs: number, waitMs?: number) => Math.max(0, Math.floor(Math.min(waitMs ?? Infinity, capMs)));

/** A time limit the runtime accepts: whole, at least 1 ms, and never longer than the wait. */
const limitWithin = (timeoutMs: number, waitMs: number) => Math.max(1, Math.floor(Math.min(timeoutMs, waitMs)));

/** Only the error's own fields, so a log line never carries the payload's inputs, outputs, or source. */
function describeRunnerError(error: unknown): { name: string; message: string; cause?: string } {
  if (!(error instanceof Error)) return { name: 'unknown', message: String(error) };
  const { cause } = error;
  const fields = { name: error.name, message: error.message };
  if (cause === undefined) return fields;
  return { ...fields, cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
}

/** Runs one payload; a runner that throws or does not answer within the wait reads as an outcome, never a hang. */
async function runWithin(
  runner: CallableFunctionRunner,
  payload: CallableFunctionRunPayload,
  waitMs: number,
  tenant: CallableFunctionTenant
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
      runner(payload, tenant).catch((error: unknown): RunResult => {
        Logger.error('[CALLABLE_FUNCTION_RUNNER_FAILED]', describeRunnerError(error));
        return { outcome: 'error', reason: 'runtime_unavailable', durationMs: Date.now() - started };
      }),
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
 * throw before the row is written writes one `error` row with `dispatch_failed`, and the throw goes on. With
 * `queuedCallId` the writer overwrites that queued row instead of inserting one.
 */
async function withCallRow<T>(
  row: ICallableFunctionCall,
  queuedCallId: string | undefined,
  body: (write: (fields: RowFields) => Promise<{ id: string }>) => Promise<T>
): Promise<T> {
  const callId = queuedCallId ?? new mongoose.Types.ObjectId().toHexString();
  let written = false;
  const save = (doc: ICallableFunctionCall) =>
    queuedCallId
      ? callableFunctionCallRepository.rewrite(callId, doc)
      : callableFunctionCallRepository.record(doc, callId);
  const write = async (fields: RowFields) => {
    written = true;
    const doc: ICallableFunctionCall = { ...row, ...fields };
    try {
      return await save(doc);
    } catch {
      return save(doc);
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

export interface CallableFunctionServerRuntime {
  kind: string;
  version: string;
  lockHash: string | null;
  packages: { name: string; version: string }[];
}

export type ServerContractRead =
  | {
      ok: true;
      contract: FunctionContract;
      callId: string;
      /** The runtime that read the contract, which every case of the same run should match. */
      runtime: CallableFunctionServerRuntime;
    }
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
  return withCallRow(row, undefined, async write => {
    const waitMs = waitFor(
      Math.min(CALLABLE_FUNCTION_SURFACE_CAPS[surface].waitMs, CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS),
      options.waitMs
    );
    const timeoutMs = limitWithin(CALLABLE_FUNCTION_CONTRACT_READ_TIMEOUT_MS, waitMs);
    const run = await runWithin(
      options.runner,
      { op: 'read_contract', code: fn.pin.source, limits: { timeoutMs } },
      waitMs,
      { callerUserId: caller.id, codeHash: fn.pin.contentHash }
    );
    row.runtime = runtimeRow(run);
    if (run.initMs !== undefined) row.initMs = run.initMs;
    const saved = await write({
      durationMs: run.durationMs,
      outcome: run.outcome,
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.errorClass ? { errorClass: run.errorClass } : {}),
    });
    if (run.outcome === 'ok' && run.contract) {
      return {
        ok: true,
        contract: run.contract,
        callId: saved.id,
        runtime: {
          kind: RUNTIME_KIND,
          version: PYODIDE_VERSION,
          lockHash: run.runtime?.lockHash ?? null,
          packages: run.runtime?.packages ?? [],
        },
      };
    }
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

const callRow = (
  { caller, functionId, surface, apiKeyId }: Omit<DispatchFunctionCallRequest, 'args'>,
  startedAt: Date
): ICallableFunctionCall => ({
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
});

/** Refusals a tool host makes before it reaches the dispatcher. */
export type CallableFunctionHostRefusal = 'not_found' | 'not_live' | 'approval_required';

/** Writes the one `refused` row for a call a tool host turned away, shaped as the dispatcher's own rows. */
export async function recordCallableFunctionRefusal(
  request: Omit<DispatchFunctionCallRequest, 'args'>,
  reason: CallableFunctionHostRefusal,
  fn?: Pick<ICallableFunctionSummary, 'userId' | 'pin'>
): Promise<{ id: string }> {
  const row = callRow(request, new Date());
  if (fn) {
    row.ownerUserId = fn.userId;
    row.codeHash = fn.pin.contentHash;
    if (fn.pin.seq !== undefined) row.pinSeq = fn.pin.seq;
  }
  return withCallRow(row, undefined, write => write({ durationMs: 0, outcome: 'refused', reason }));
}

/**
 * Checks, in order, the setting, the record, the caller (`canCallFunction`; a recipient also needs a current,
 * enabled review of the interface the call runs against), the status, the input size, and the inputs, then runs the
 * pinned code, checks the outputs, and stamps the result. Every path, a throw included, writes one call-log row with
 * hashes and sizes only. A function the caller cannot call answers `not_found`, as a missing one does; only the row
 * says `not_caller`. With `enqueue`, a call that passes every check is queued instead of run.
 */
export function dispatchFunctionCall(
  request: DispatchFunctionCallRequest,
  options?: CallableFunctionDispatchOptions & { enqueue?: undefined }
): Promise<DispatchFunctionCallResult<CallableFunctionCallOutcome>>;
export function dispatchFunctionCall(
  request: DispatchFunctionCallRequest,
  options: CallableFunctionDispatchOptions
): Promise<DispatchFunctionCallResult>;
export async function dispatchFunctionCall(
  request: DispatchFunctionCallRequest,
  options: CallableFunctionDispatchOptions = {}
): Promise<DispatchFunctionCallResult> {
  const { caller, functionId, args, surface, apiKeyId } = request;
  const startedAt = new Date();
  const row = callRow({ caller, functionId, surface, apiKeyId }, startedAt);

  return withCallRow(row, options.callId, async write => {
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

    const record = await callableFunctionRepository.findById(functionId);
    if (!record) return refuse('not_found');
    row.ownerUserId = record.userId;
    row.codeHash = record.pin.contentHash;
    if (record.pin.seq !== undefined) row.pinSeq = record.pin.seq;

    const access = await canCallFunction(caller, record);
    if (!access) return finish({ outcome: 'refused', reason: 'not_found' }, 'not_caller');
    // A recipient runs the last promotion while the owner's edits leave the record a draft.
    const fn = access === 'owner' ? record : recipientCallableFunction(record);
    if (!fn) return finish({ outcome: 'refused', reason: 'not_found' }, 'not_caller');
    row.codeHash = fn.pin.contentHash;
    if (fn.pin.seq !== undefined) row.pinSeq = fn.pin.seq;
    const contract = options.contract ?? fn.contract;
    let approval = fn.approval;
    if (access !== 'owner') {
      const review = await callableFunctionReviewRepository.findFor(fn.id, caller.id);
      if (!review || !(await isCurrentReview(review, contract))) return refuse('review_required');
      approval = review.approval;
    }

    const status = effectiveCallableFunctionStatus(fn, await readHead(fn));
    if (status === 'disabled' || status === 'source_deleted') return refuse(status);
    if (surface === 'chat' || surface === 'agent') {
      if (status !== 'live') return refuse('not_live');
      if (approval === 'always_ask' && request.approved !== true) return refuse('approval_required');
    }

    // Measured before validation, so an input of any size is never walked.
    const caps = CALLABLE_FUNCTION_SURFACE_CAPS[surface];
    row.inputBytes = functionJsonBytes(JSON.stringify(args) ?? '');
    if (row.inputBytes > Math.min(caps.inputBytes, CALLABLE_FUNCTION_LIMITS.inputBytes)) {
      return finish({ outcome: 'input_invalid', reason: 'input_too_large' });
    }

    if (isObject(args)) row.inputHash = functionInputHash(args);
    const problems = validateFunctionValue(contract.inputs, args);
    if (problems.length > 0) return finish({ outcome: 'input_invalid', problems });

    const runner = options.runner === undefined ? selectCallableFunctionRunner() : options.runner;
    if (!runner) return finish({ outcome: 'refused', reason: 'runtime_unavailable' });

    if (options.enqueue) {
      const queued = await finish({ outcome: 'queued' });
      try {
        await options.enqueue(queued.callId);
      } catch {
        await callableFunctionCallRepository.rewrite(queued.callId, { outcome: 'error', reason: 'queue_failed' });
        return { ...queued, outcome: 'error', reason: 'queue_failed' };
      }
      return queued;
    }

    const params = args as Record<string, unknown>;
    const inputHash = row.inputHash ?? functionInputHash(params);
    const requestedMs = options.timeoutMs ?? CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS;
    const capMs =
      options.callId === undefined
        ? caps.waitMs
        : requestedMs + CALLABLE_FUNCTION_START_BUDGET_MS + CALLABLE_FUNCTION_PARENT_MARGIN_MS;
    const budgetStarted = Date.now();
    const budgetMs = waitFor(capMs, options.deadline === undefined ? options.waitMs : options.deadline - budgetStarted);
    if (options.minWaitMs !== undefined && budgetMs < options.minWaitMs) {
      return finish({ outcome: 'refused', reason: 'budget_exhausted' });
    }
    const outputBytesCap = Math.min(caps.outputBytes, CALLABLE_FUNCTION_LIMITS.outputBytes);
    const pins = fn.pin.dataPins ?? [];
    row.dataHashes = pins.map(pin => pin.sha256);
    // Elsewhere the files bucket would be signed for keys that live in the data bucket: refuse loudly instead.
    if ((pins.length > 0 || fn.sources?.length) && !(options.dataReachable ?? callableFunctionDataReachable())) {
      Logger.error('[CALLABLE_FUNCTION_DATA_NOT_WIRED]', { functionId: fn.id });
      return finish({ outcome: 'error', reason: 'data_unavailable' });
    }
    // Fetched outside the sandbox before the run, so the runtime keeps its closed network and reads them as files.
    let sources: CallableFunctionStampData[] = [];
    let sourceKeys: string[] = [];
    const fetchStarted = Date.now();
    const fetchMs = Math.min(requestedMs, budgetMs);
    if (fn.sources?.length) {
      try {
        const reads = await resolveCallableFunctionSources(fn, options.sources, { timeoutMs: fetchMs });
        sources = reads.map(read => read.entry);
        sourceKeys = reads.map(read => read.key);
      } catch (error) {
        // A stall that spent the call's own time, or the caller's wait, ends as the run would have: a timeout. The
        // code covers a timer that fires a millisecond early; under the fetch's own ceiling, `fetchMs` is its limit.
        const stalled =
          Date.now() - fetchStarted >= fetchMs ||
          (error instanceof CallableFunctionSourceError &&
            error.code === 'source_timeout' &&
            fetchMs <= CALLABLE_FUNCTION_SOURCE_TIMEOUT_MS);
        if (stalled) {
          return finish(
            fetchMs < requestedMs ? { outcome: 'timeout', reason: 'wait_exceeded' } : { outcome: 'timeout' }
          );
        }
        Logger.error('[CALLABLE_FUNCTION_SOURCE_FAILED]', describeRunnerError(error));
        const errorClass = error instanceof CallableFunctionSourceError ? error.code : undefined;
        return finish({ outcome: 'error', reason: 'source_unavailable', ...(errorClass ? { errorClass } : {}) });
      }
      row.dataHashes = [...row.dataHashes, ...sources.map(entry => entry.sha256)];
    }
    // The source fetch spends the call's own time limit and the same wait as the run.
    const runMs = runTimeoutAfterDownload(requestedMs, Date.now() - fetchStarted);
    if (runMs === 0) return finish({ outcome: 'timeout' });
    const waitMs = Math.max(0, budgetMs - (Date.now() - budgetStarted));
    if (options.minWaitMs !== undefined && waitMs < options.minWaitMs) {
      return finish({ outcome: 'refused', reason: 'budget_exhausted' });
    }
    const timeoutMs = limitWithin(runMs, waitMs);
    let data: CallableFunctionRunData[] | undefined;
    if (pins.length > 0 || sources.length > 0) {
      // Links for exactly this function's files, valid for minutes; the runtime gets links, never the bytes.
      try {
        const links = [
          ...(pins.length > 0 ? await (options.signData ?? signCallableFunctionDataLinks)(fn) : []),
          ...(await signCallableFunctionDataEntries(
            fn.id,
            sources.map((entry, index) => ({ ...entry, key: sourceKeys[index] })),
            options.sources?.storage
          )),
        ];
        data = links.map(link => ({ ...link, prefix: fn.id }));
      } catch (error) {
        Logger.error('[CALLABLE_FUNCTION_DATA_SIGN_FAILED]', describeRunnerError(error));
        return finish({ outcome: 'error', reason: 'data_unavailable' });
      }
    }
    const run = await runWithin(
      runner,
      {
        op: 'call',
        code: fn.pin.source,
        contract,
        params,
        limits: { timeoutMs, outputBytes: outputBytesCap },
        ...(data ? { data } : {}),
      },
      waitMs,
      { callerUserId: caller.id, codeHash: fn.pin.contentHash }
    );
    row.runtime = runtimeRow(run);
    if (run.initMs !== undefined) row.initMs = run.initMs;
    const stamp = buildCallableFunctionStamp({ fn, inputHash, run, surface, calledAt: startedAt, sources });
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
