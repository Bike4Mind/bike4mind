import {
  BadRequestError,
  ConflictError,
  PYODIDE_VERSION,
  callableFunctionTrustLabel,
  describeFunctionContractChange,
  diffFunctionContracts,
  toCallableFunctionPublic,
  type CallableFunctionRuntimePin,
  type CallableFunctionServerRun,
  type CallableFunctionServerRunCase,
  type FunctionContractChange,
  type ICallableFunctionPublic,
} from '@bike4mind/common';
import { callableFunctionRepository } from '@bike4mind/database';
import type { CallableFunctionRunner } from './runtimeRunner';
import { prepareServerRun, runServerCases, type CallableFunctionTestCaseResult } from './testRun';

export interface CallableFunctionPromotion {
  function: ICallableFunctionPublic;
  run: CallableFunctionServerRun;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function changeText(change: FunctionContractChange): string {
  const { subject, field, words } = describeFunctionContractChange(change);
  return [subject, field, words].filter(Boolean).join(' ');
}

function failureText(result: CallableFunctionTestCaseResult): string {
  if (result.mismatch) {
    const { path, expected, actual } = result.mismatch;
    return `output ${path} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (result.outcome === 'timeout') return 'stopped at the time limit';
  if (result.outcome === 'error' && result.errorClass) return `raised ${result.errorClass}`;
  return `ended with ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`;
}

/**
 * Promotes the owner's function to `live`. The server reads `FUNCTION` from the pinned code and refuses a contract
 * that differs from the stored one or breaks the last promoted one, then runs every declared test and worked example
 * through the dispatcher; only when all pass does it write the sequence, runtime, run, label, and state.
 */
export async function promoteCallableFunction(
  actor: { id: string },
  id: string,
  options: { runner?: CallableFunctionRunner | null } = {}
): Promise<CallableFunctionPromotion> {
  const target = await prepareServerRun(actor, id, options);
  const { fn, contract } = target;

  if (fn.promoted) {
    const diff = diffFunctionContracts(fn.promoted.contract, contract);
    const breaking = diff?.breaking ?? [];
    if (!diff || breaking.length > 0) {
      const what = diff ? breaking.map(changeText).join('; ') : 'the promoted contract cannot be read';
      throw new ConflictError(
        `${sentence(what)} since promotion ${fn.promoted.seq}, which could break callers of the tool. Save this version as a new tool instead.`,
        { code: 'breaking_change', changes: breaking }
      );
    }
  }

  const tests = contract.tests ?? [];
  const examples = fn.examples ?? [];
  if (tests.length + examples.length === 0) {
    throw new BadRequestError('Declare a test or add a worked example before promoting.', { code: 'no_cases' });
  }

  const ran = [
    ...(await runServerCases(actor, target, tests)).map(result => ({ kind: 'test' as const, result })),
    ...(await runServerCases(actor, target, examples)).map(result => ({ kind: 'example' as const, result })),
  ];
  const cases: CallableFunctionServerRunCase[] = ran.flatMap(({ kind, result }) =>
    result.outcome === 'not_run'
      ? []
      : [
          {
            name: result.name,
            kind,
            passed: result.passed,
            outcome: result.outcome,
            ...(result.reason ? { reason: result.reason } : {}),
            durationMs: result.durationMs,
            callId: result.callId,
          },
        ]
  );

  const failures = ran.filter(({ result }) => !result.passed);
  if (failures.length > 0) {
    const { kind, result } = failures[0]!;
    const others = failures.length > 1 ? ` ${failures.length - 1} more case(s) failed too.` : '';
    throw new ConflictError(
      `${kind === 'example' ? 'Worked example' : 'Test'} "${result.name}" failed on the server: ${failureText(result)}.${others}`,
      { code: kind === 'example' ? 'example_failed' : 'test_failed', results: cases }
    );
  }

  const stamp = ran.flatMap(({ result }) => (result.outcome !== 'not_run' && result.stamp ? [result.stamp] : []))[0];
  const runtime: CallableFunctionRuntimePin = {
    kind: stamp?.runtime.kind ?? 'pyodide-server',
    version: stamp?.runtime.version ?? PYODIDE_VERSION,
    ...(stamp?.runtime.lock_hash ? { lockHash: stamp.runtime.lock_hash } : {}),
    packages: stamp?.packages ?? [],
  };
  const run: CallableFunctionServerRun = {
    at: new Date(),
    passed: cases.length,
    failed: 0,
    results: cases,
    ...(stamp ? { stamp } : {}),
  };
  const promoted = await callableFunctionRepository.promote(
    fn.id,
    { ownerType: 'user', ownerKey: actor.id },
    { updatedAt: fn.updatedAt },
    {
      seq: (fn.promoted?.seq ?? 0) + 1,
      runtime,
      lastServerRun: run,
      trustLabel: callableFunctionTrustLabel(cases),
      contract,
    }
  );
  // A repin, an examples edit, or another promotion landed while the cases ran.
  if (!promoted) {
    throw new ConflictError('The tool changed while it was being promoted. Reload it and try again.', {
      code: 'version_changed',
    });
  }
  return { function: toCallableFunctionPublic(promoted, target.head), run };
}
