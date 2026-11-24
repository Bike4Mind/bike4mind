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
  dispatchFunctionCall,
  readServerContract,
  type CallableFunctionCallReason,
  type CallableFunctionStamp,
} from './dispatch';
import { selectCallableFunctionRunner, type CallableFunctionRunner } from './runtimeRunner';

export interface CallableFunctionTestCaseResult {
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

export interface CallableFunctionTestRun {
  functionId: string;
  passed: number;
  failed: number;
  results: CallableFunctionTestCaseResult[];
}

/**
 * Runs every test the pinned code declares through the dispatcher, one call each, in order. The tests come from the
 * contract the server reads from the pinned code, never from the record's display copy or the browser.
 */
export async function runCallableFunctionTests(
  actor: { id: string },
  id: string,
  options: { runner?: CallableFunctionRunner | null } = {}
): Promise<CallableFunctionTestRun> {
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
  const read = await readServerContract(fn.pin.source, runner);
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
  const tests = read.contract.tests ?? [];
  if (tests.length === 0) throw new BadRequestError('This function declares no tests.', { code: 'no_tests' });

  const results: CallableFunctionTestCaseResult[] = [];
  for (const test of tests) {
    const call = await dispatchFunctionCall(
      { caller: actor, functionId: fn.id, args: test.input, surface: 'test' },
      { runner, contract: read.contract }
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
  return { functionId: fn.id, passed, failed: results.length - passed, results };
}
