import { createHash } from 'node:crypto';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
  canonicalJson,
  compareFunctionOutput,
  effectiveCallableFunctionStatus,
  type CallableFunctionCallOutcome,
  type CallableFunctionCaseResult,
  type CallableFunctionCaseResults,
  type CallableFunctionHead,
  type FunctionContract,
  type FunctionContractProblem,
  type FunctionOutputMismatch,
  type FunctionTestCase,
  type ICallableFunctionDocument,
} from '@bike4mind/common';
import { artifactRepository, callableFunctionRepository } from '@bike4mind/database';
import { assertCallableFunctionsEnabled } from './access';
import { callableFunctionDataHash } from './dataPins';
import {
  CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS,
  dispatchFunctionCall,
  readServerContract,
  type CallableFunctionCallReason,
  type CallableFunctionServerRuntime,
  type CallableFunctionStamp,
} from './dispatch';
import { CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS } from './runtimeParent';
import { selectCallableFunctionRunner, type CallableFunctionRunner } from './runtimeRunner';
import type { CallableFunctionSourceDeps } from './sources';

/**
 * One test run answers inside the web function's 60 s (`infra/web.ts`): the contract read and every case draw from
 * this budget, and the margin covers sign-in, the setting, the record reads, and the row writes around it.
 */
export const CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS = 45_000;
export const CALLABLE_FUNCTION_TEST_RUN_MARGIN_MS = 15_000;

/** A case starts only with this much budget left (a warm start plus a short run); later cases come back not run. */
export const CALLABLE_FUNCTION_TEST_CASE_MIN_MS = 5_000;

/** Lowers the budget for a local run that needs a short one; it can never raise it. */
export const CALLABLE_FUNCTION_TEST_RUN_BUDGET_ENV = 'CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS';

export function callableFunctionTestRunBudget(env: NodeJS.ProcessEnv = process.env): number {
  const lowered = Number(env[CALLABLE_FUNCTION_TEST_RUN_BUDGET_ENV]);
  return Number.isFinite(lowered) && lowered > 0
    ? Math.min(lowered, CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS)
    : CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS;
}

export type CallableFunctionTestCaseResult =
  | {
      name: string;
      passed: boolean;
      outcome: CallableFunctionCallOutcome;
      reason?: CallableFunctionCallReason;
      errorClass?: string;
      problems?: FunctionContractProblem[];
      /** The first field that differs from `expected`; null when the outputs match or the call did not return any. */
      mismatch: FunctionOutputMismatch | null;
      durationMs: number;
      /** The call-log row this case wrote. */
      callId: string;
      stamp?: CallableFunctionStamp;
      /** Timed out under a limit the budget lowered, so the case did not get its own time to finish. */
      budgetCut?: true;
    }
  | {
      name: string;
      passed: false;
      /** The budget ran out before this case; nothing ran. */
      outcome: 'not_run';
      reason: 'budget_exhausted';
      mismatch: null;
      /** The dispatcher's refusal row, when its own reads left the case too little time. */
      callId?: string;
    };

export interface CallableFunctionTestRun {
  functionId: string;
  passed: number;
  failed: number;
  notRun: number;
  /** The contract read's call-log row. */
  contractCallId: string;
  results: CallableFunctionTestCaseResult[];
}

export interface CallableFunctionServerRunOptions {
  runner?: CallableFunctionRunner | null;
  /** Never above `CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS`. */
  budgetMs?: number;
  /** For the function's sources; the environment's fetcher and store by default. */
  sources?: CallableFunctionSourceDeps;
}

export interface CallableFunctionTestRunOptions extends CallableFunctionServerRunOptions {
  /** Names of the declared tests to run, in declared order; every test when absent. */
  tests?: string[];
}

export interface CallableFunctionServerRunTarget {
  fn: ICallableFunctionDocument;
  head: CallableFunctionHead | null;
  runner: CallableFunctionRunner;
  /** The contract the server read from the pinned code, equal to the stored one. */
  contract: FunctionContract;
  /** The contract read's call-log row. */
  contractCallId: string;
  runtime: CallableFunctionServerRuntime;
  /** Epoch ms after which no case starts; the contract read and every case draw from one budget. */
  deadline: number;
  /** Passed to every case's dispatch; a promotion adds the sources it fetched. */
  sources?: CallableFunctionSourceDeps;
}

/** Read outcomes that mean the runtime is not ready yet, so a retry can succeed. */
const isStarting = (reason: CallableFunctionCallReason | undefined) =>
  reason === 'wait_exceeded' || reason === 'start_timeout';

/**
 * The checks every server run of a saved function makes before any case runs: the setting, the owner's record, its
 * status, a runtime, and a server read of `FUNCTION` from the pinned code that matches the stored contract. The
 * budget starts here. Another owner's function answers 404, as a missing one does.
 */
export async function prepareServerRun(
  actor: { id: string },
  id: string,
  options: CallableFunctionServerRunOptions = {}
): Promise<CallableFunctionServerRunTarget> {
  const budgetMs = Math.min(options.budgetMs ?? callableFunctionTestRunBudget(), CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const left = () => deadline - Date.now();

  await assertCallableFunctionsEnabled(actor);
  const fn = await callableFunctionRepository.findByIdForOwner(id, { ownerType: 'user', ownerKey: actor.id });
  if (!fn) throw new NotFoundError('Tool not found');

  const artifact = await artifactRepository.findOne({ id: fn.pin.artifactId, userId: actor.id });
  const head = artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null;
  const status = effectiveCallableFunctionStatus(fn, head);
  if (status === 'disabled' || status === 'source_deleted') {
    throw new ConflictError(
      status === 'disabled' ? 'This tool is turned off.' : 'The artifact behind this tool was deleted.',
      { code: 'not_callable', status }
    );
  }

  const runner = options.runner === undefined ? selectCallableFunctionRunner() : options.runner;
  if (!runner) {
    throw new ServiceUnavailableError('Functions cannot run on the server here.', { code: 'runtime_unavailable' });
  }
  const read = await readServerContract(
    { caller: actor, fn, surface: 'test' },
    { runner, waitMs: Math.min(left(), CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS) }
  );
  if (!read.ok && isStarting(read.reason)) {
    throw new ServiceUnavailableError('The runtime is starting. Try again in a minute.', { code: 'runtime_starting' });
  }
  if (!read.ok && read.reason === 'runtime_unavailable') {
    throw new ServiceUnavailableError('The server runtime did not answer. Try again.', { code: 'runtime_unavailable' });
  }
  if (!read.ok) {
    throw new UnprocessableEntityError('The server could not read the function contract.', {
      code: 'contract_unreadable',
      outcome: read.outcome,
      ...(read.reason ? { reason: read.reason } : {}),
      ...(read.problems ? { problems: read.problems } : {}),
    });
  }
  if (canonicalJson(read.contract) !== canonicalJson(fn.contract)) {
    throw new ConflictError('The saved contract does not match the pinned code. Update the tool and try again.', {
      code: 'contract_changed',
    });
  }
  return {
    fn,
    head,
    runner,
    contract: read.contract,
    contractCallId: read.callId,
    runtime: read.runtime,
    deadline,
    ...(options.sources ? { sources: options.sources } : {}),
  };
}

export type CallableFunctionServerCase = Pick<FunctionTestCase, 'name' | 'input' | 'expected' | 'tolerance'>;

/** sha256 hex of what a case checks: a rename keeps it, any change to the input, expected, or tolerance does not. */
export const callableFunctionCaseHash = (testCase: CallableFunctionServerCase): string =>
  createHash('sha256')
    .update(
      canonicalJson({ input: testCase.input, expected: testCase.expected, tolerance: testCase.tolerance ?? null }),
      'utf8'
    )
    .digest('hex');

// A function with sources reads data fetched for each run, so no earlier result stands for this one.
const sameRunKey = (recorded: CallableFunctionCaseResults, target: CallableFunctionServerRunTarget) =>
  !target.fn.sources?.length &&
  recorded.pinVersion === target.fn.pin.version &&
  recorded.contentHash === target.fn.pin.contentHash &&
  recorded.runtimeVersion === target.runtime.version &&
  recorded.lockHash === target.runtime.lockHash &&
  recorded.dataHash === callableFunctionDataHash(target.fn.pin.dataPins);

/** True when a case's stamp names the runtime that read the contract. */
export const ranOnTargetRuntime = (target: CallableFunctionServerRunTarget, result: CallableFunctionTestCaseResult) =>
  result.outcome !== 'not_run' &&
  result.stamp !== undefined &&
  result.stamp.runtime.version === target.runtime.version &&
  result.stamp.runtime.lock_hash === target.runtime.lockHash;

/** Passes recorded on this pin, code, and runtime, by case hash; a recorded failure is never among them. */
export function reusableCasePasses(target: CallableFunctionServerRunTarget): Map<string, CallableFunctionCaseResult> {
  const recorded = target.fn.caseResults;
  if (!recorded || !sameRunKey(recorded, target)) return new Map();
  return new Map(recorded.cases.filter(entry => entry.passed).map(entry => [entry.caseHash, entry]));
}

/**
 * Records each case that ran on the target's runtime, pass or fail, over the earlier results for the same run key,
 * keeping only cases in `current` so the record stays within the declared tests and examples.
 */
export async function recordServerCaseResults(
  actor: { id: string },
  target: CallableFunctionServerRunTarget,
  ran: { kind: 'test' | 'example'; caseHash: string; result: CallableFunctionTestCaseResult }[],
  current: Set<string>
): Promise<void> {
  const recorded = target.fn.caseResults;
  const byHash = new Map<string, CallableFunctionCaseResult>(
    recorded && sameRunKey(recorded, target)
      ? recorded.cases.filter(entry => current.has(entry.caseHash)).map(entry => [entry.caseHash, entry])
      : []
  );
  let changed = false;
  for (const { kind, caseHash, result } of ran) {
    if (result.outcome === 'not_run' || result.budgetCut || !ranOnTargetRuntime(target, result)) continue;
    byHash.set(caseHash, {
      caseHash,
      name: result.name,
      kind,
      passed: result.passed,
      outcome: result.outcome,
      durationMs: result.durationMs,
      callId: result.callId,
      at: new Date(),
    });
    changed = true;
  }
  if (!changed) return;
  const dataHash = callableFunctionDataHash(target.fn.pin.dataPins);
  const results: CallableFunctionCaseResults = {
    pinVersion: target.fn.pin.version,
    contentHash: target.fn.pin.contentHash,
    runtimeVersion: target.runtime.version,
    lockHash: target.runtime.lockHash,
    ...(dataHash ? { dataHash } : {}),
    cases: [...byHash.values()],
  };
  await callableFunctionRepository.recordCaseResults(target.fn.id, { ownerType: 'user', ownerKey: actor.id }, results);
  target.fn.caseResults = results;
}

/**
 * Runs each case through the dispatcher, one call and one call-log row each, in order, while the target's budget
 * lasts; a case without `CALLABLE_FUNCTION_TEST_CASE_MIN_MS` left, before or after the dispatcher's own reads, comes
 * back `not_run`.
 */
export async function runServerCases(
  actor: { id: string },
  target: CallableFunctionServerRunTarget,
  cases: CallableFunctionServerCase[]
): Promise<CallableFunctionTestCaseResult[]> {
  const results: CallableFunctionTestCaseResult[] = [];
  const skipped = (name: string, callId?: string): CallableFunctionTestCaseResult => ({
    name,
    passed: false,
    outcome: 'not_run',
    reason: 'budget_exhausted',
    mismatch: null,
    ...(callId ? { callId } : {}),
  });
  for (const testCase of cases) {
    if (target.deadline - Date.now() < CALLABLE_FUNCTION_TEST_CASE_MIN_MS) {
      results.push(skipped(testCase.name));
      continue;
    }
    const call = await dispatchFunctionCall(
      { caller: actor, functionId: target.fn.id, args: testCase.input, surface: 'test' },
      {
        runner: target.runner,
        contract: target.contract,
        deadline: target.deadline,
        minWaitMs: CALLABLE_FUNCTION_TEST_CASE_MIN_MS,
        ...(target.sources ? { sources: target.sources } : {}),
      }
    );
    if (call.outcome === 'refused' && call.reason === 'budget_exhausted') {
      results.push(skipped(testCase.name, call.callId));
      continue;
    }
    const mismatch =
      call.outcome === 'ok' ? compareFunctionOutput(testCase.expected, call.outputs, testCase.tolerance) : null;
    // The runner started `durationMs` ago; less than the default limit left then means the budget set the limit.
    const leftAtStart = target.deadline - (Date.now() - call.durationMs);
    results.push({
      name: testCase.name,
      passed: call.outcome === 'ok' && mismatch === null,
      outcome: call.outcome,
      ...(call.reason ? { reason: call.reason } : {}),
      ...(call.errorClass ? { errorClass: call.errorClass } : {}),
      ...(call.problems?.length ? { problems: call.problems } : {}),
      mismatch,
      durationMs: call.durationMs,
      callId: call.callId,
      ...(call.stamp ? { stamp: call.stamp } : {}),
      ...(call.outcome === 'timeout' && leftAtStart < CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS ? { budgetCut: true } : {}),
    });
  }
  return results;
}

/**
 * Runs the tests the pinned code declares through the dispatcher, one call each, in order, within one budget. The
 * tests come from the contract the server reads from the pinned code, never from the record's display copy or the
 * browser.
 */
export async function runCallableFunctionTests(
  actor: { id: string },
  id: string,
  options: CallableFunctionTestRunOptions = {}
): Promise<CallableFunctionTestRun> {
  const target = await prepareServerRun(actor, id, options);
  const declared = target.contract.tests ?? [];
  if (declared.length === 0) throw new BadRequestError('This function declares no tests.', { code: 'no_tests' });
  const wanted = options.tests ? new Set(options.tests) : null;
  const unknown = options.tests?.filter(name => !declared.some(test => test.name === name)) ?? [];
  if (unknown.length > 0) {
    throw new BadRequestError('The function declares no test with that name.', {
      code: 'unknown_test',
      names: unknown,
    });
  }
  const tests = wanted ? declared.filter(test => wanted.has(test.name)) : declared;

  const results = await runServerCases(actor, target, tests);
  const current = new Set([...declared, ...(target.fn.examples ?? [])].map(callableFunctionCaseHash));
  await recordServerCaseResults(
    actor,
    target,
    tests.map((test, index) => ({ kind: 'test', caseHash: callableFunctionCaseHash(test), result: results[index]! })),
    current
  );
  const passed = results.filter(result => result.passed).length;
  const notRun = results.filter(result => result.outcome === 'not_run').length;
  return {
    functionId: target.fn.id,
    passed,
    failed: results.length - passed - notRun,
    notRun,
    contractCallId: target.contractCallId,
    results,
  };
}
