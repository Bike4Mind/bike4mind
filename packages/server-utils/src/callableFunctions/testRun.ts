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
  type FunctionContractProblem,
  type FunctionOutputMismatch,
} from '@bike4mind/common';
import { artifactRepository, callableFunctionRepository } from '@bike4mind/database';
import { assertCallableFunctionsEnabled } from './access';
import {
  CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS,
  dispatchFunctionCall,
  readServerContract,
  type CallableFunctionCallReason,
  type CallableFunctionStamp,
} from './dispatch';
import { selectCallableFunctionRunner, type CallableFunctionRunner } from './runtimeRunner';

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
    }
  | {
      name: string;
      passed: false;
      /** The budget ran out before this case; nothing ran and no row was written. */
      outcome: 'not_run';
      reason: 'budget_exhausted';
      mismatch: null;
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

export interface CallableFunctionTestRunOptions {
  runner?: CallableFunctionRunner | null;
  /** Names of the declared tests to run, in declared order; every test when absent. */
  tests?: string[];
  /** Never above `CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS`. */
  budgetMs?: number;
}

/** Read outcomes that mean the runtime is not ready yet, so a retry can succeed. */
const isStarting = (reason: CallableFunctionCallReason | undefined) =>
  reason === 'wait_exceeded' || reason === 'start_timeout';

/**
 * Runs the tests the pinned code declares through the dispatcher, one call each, in order, within one budget. The
 * tests come from the contract the server reads from the pinned code, never from the record's display copy or the
 * browser. Another owner's function answers 404, as a missing one does.
 */
export async function runCallableFunctionTests(
  actor: { id: string },
  id: string,
  options: CallableFunctionTestRunOptions = {}
): Promise<CallableFunctionTestRun> {
  const budgetMs = Math.min(
    options.budgetMs ?? CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS,
    CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS
  );
  const deadline = Date.now() + budgetMs;
  const left = () => deadline - Date.now();

  await assertCallableFunctionsEnabled(actor);
  const fn = await callableFunctionRepository.findByIdForOwner(id, { ownerType: 'user', ownerKey: actor.id });
  if (!fn) throw new NotFoundError('Tool not found');

  const artifact = await artifactRepository.findOne({ id: fn.pin.artifactId, userId: actor.id });
  const status = effectiveCallableFunctionStatus(
    fn,
    artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null
  );
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
  const declared = read.contract.tests ?? [];
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

  const results: CallableFunctionTestCaseResult[] = [];
  for (const test of tests) {
    const waitMs = left();
    if (waitMs < CALLABLE_FUNCTION_TEST_CASE_MIN_MS) {
      results.push({ name: test.name, passed: false, outcome: 'not_run', reason: 'budget_exhausted', mismatch: null });
      continue;
    }
    const call = await dispatchFunctionCall(
      { caller: actor, functionId: fn.id, args: test.input, surface: 'test' },
      { runner, contract: read.contract, waitMs }
    );
    const mismatch = call.outcome === 'ok' ? compareFunctionOutput(test.expected, call.outputs, test.tolerance) : null;
    results.push({
      name: test.name,
      passed: call.outcome === 'ok' && mismatch === null,
      outcome: call.outcome,
      ...(call.reason ? { reason: call.reason } : {}),
      ...(call.errorClass ? { errorClass: call.errorClass } : {}),
      ...(call.problems?.length ? { problems: call.problems } : {}),
      mismatch,
      durationMs: call.durationMs,
      callId: call.callId,
      ...(call.stamp ? { stamp: call.stamp } : {}),
    });
  }
  const passed = results.filter(result => result.passed).length;
  const notRun = results.filter(result => result.outcome === 'not_run').length;
  return {
    functionId: fn.id,
    passed,
    failed: results.length - passed - notRun,
    notRun,
    contractCallId: read.callId,
    results,
  };
}
