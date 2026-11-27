import {
  BadRequestError,
  ConflictError,
  callableFunctionTrustLabel,
  describeFunctionContractChange,
  diffFunctionContracts,
  toCallableFunctionPublic,
  type CallableFunctionRuntimePin,
  type CallableFunctionServerRun,
  type CallableFunctionServerRunCase,
  type FunctionContractChange,
  type ICallableFunctionPublic,
  type ICallableFunctionSourcePin,
} from '@bike4mind/common';
import { callableFunctionRepository } from '@bike4mind/database';
import { CallableFunctionSourceError } from './fetchSource';
import { fetchPinnedCallableFunctionSources } from './sources';
import {
  callableFunctionCaseHash,
  prepareServerRun,
  ranOnTargetRuntime,
  recordServerCaseResults,
  reusableCasePasses,
  runServerCases,
  type CallableFunctionServerCase,
  type CallableFunctionServerRunOptions,
  type CallableFunctionTestCaseResult,
} from './testRun';

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

interface PromotionCase {
  kind: 'test' | 'example';
  testCase: CallableFunctionServerCase;
  caseHash: string;
}

/**
 * Promotes the owner's function to `live`. The server reads `FUNCTION` from the pinned code and refuses a contract
 * that differs from the stored one or breaks the last promoted one. Every declared test and worked example must then
 * have passed on the server on this pin, code, and runtime: passes recorded by earlier runs are reused, and the rest
 * run within one budget. Only when every case has passed does it write the sequence, runtime, run, label, and state;
 * cases the budget did not reach are refused as `cases_left`, and their passes are kept for the next promotion.
 */
export async function promoteCallableFunction(
  actor: { id: string },
  id: string,
  options: CallableFunctionServerRunOptions = {}
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

  const all: PromotionCase[] = [
    ...(contract.tests ?? []).map(testCase => ({ kind: 'test' as const, testCase })),
    ...(fn.examples ?? []).map(testCase => ({ kind: 'example' as const, testCase })),
  ].map(entry => ({ ...entry, caseHash: callableFunctionCaseHash(entry.testCase) }));
  if (all.length === 0) {
    throw new BadRequestError('Declare a test or add a worked example before promoting.', { code: 'no_cases' });
  }

  // The pinned sources are fetched once here; the cases read these bytes and the promotion freezes them.
  let sourcePins: ICallableFunctionSourcePin[];
  try {
    sourcePins = await fetchPinnedCallableFunctionSources(fn, target.sources);
  } catch (error) {
    if (!(error instanceof CallableFunctionSourceError)) throw error;
    throw new ConflictError(`A pinned source could not be fetched: ${error.message}`, { code: error.code });
  }
  target.sources = { ...target.sources, sourcePins };

  const reusable = reusableCasePasses(target);
  const fresh = all.filter(entry => !reusable.has(entry.caseHash));
  const freshResults = await runServerCases(
    actor,
    target,
    fresh.map(entry => entry.testCase)
  );
  const resultFor = new Map<PromotionCase, CallableFunctionTestCaseResult>();
  fresh.forEach((entry, index) => {
    const result = freshResults[index];
    if (result) resultFor.set(entry, result);
  });
  const ran = [...resultFor].map(([entry, result]) => ({ ...entry, result }));
  await recordServerCaseResults(actor, target, ran, new Set(all.map(entry => entry.caseHash)));

  const runCases: CallableFunctionServerRunCase[] = [];
  for (const entry of all) {
    const reused = reusable.get(entry.caseHash);
    const result = resultFor.get(entry);
    if (reused) {
      runCases.push({
        name: entry.testCase.name,
        kind: entry.kind,
        passed: true,
        outcome: reused.outcome,
        durationMs: reused.durationMs,
        callId: reused.callId,
      });
    } else if (result && result.outcome !== 'not_run') {
      runCases.push({
        name: result.name,
        kind: entry.kind,
        passed: result.passed,
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
        durationMs: result.durationMs,
        callId: result.callId,
      });
    }
  }

  const failures = ran.filter(({ result }) => result.outcome !== 'not_run' && !result.passed && !result.budgetCut);
  if (failures.length > 0) {
    const { kind, result } = failures[0]!;
    const others = failures.length > 1 ? ` ${failures.length - 1} more case(s) failed too.` : '';
    throw new ConflictError(
      `${kind === 'example' ? 'Worked example' : 'Test'} "${result.name}" failed on the server: ${failureText(result)}.${others}`,
      { code: kind === 'example' ? 'example_failed' : 'test_failed', results: runCases }
    );
  }

  // A deploy between cases: the cases did not all run on the runtime the pin would name. A killed case's stamp has
  // no lock hash, so a case the budget cut short says nothing about the runtime.
  const otherRuntime = ran.find(
    ({ result }) =>
      result.outcome !== 'not_run' &&
      !result.budgetCut &&
      result.stamp !== undefined &&
      !ranOnTargetRuntime(target, result)
  );
  if (otherRuntime) {
    throw new ConflictError('The server runtime changed while the cases ran. Promote again.', {
      code: 'runtime_changed',
      results: runCases,
    });
  }

  const passedHere = (result: CallableFunctionTestCaseResult | undefined) =>
    result !== undefined && result.passed && ranOnTargetRuntime(target, result);
  const left = all.filter(entry => !reusable.has(entry.caseHash) && !passedHere(resultFor.get(entry)));
  if (freshResults.length !== fresh.length || runCases.length !== all.length || left.length > 0) {
    const passed = all.length - left.length;
    throw new ConflictError(
      `${passed} of ${all.length} cases have passed on the server for this version. Promote again to run the other ${left.length}.`,
      {
        code: 'cases_left',
        passed,
        total: all.length,
        left: left.map(entry => ({ kind: entry.kind, name: entry.testCase.name })),
        results: runCases,
      }
    );
  }

  const stamp = ran.flatMap(({ result }) => (result.outcome !== 'not_run' && result.stamp ? [result.stamp] : []))[0];
  const runtime: CallableFunctionRuntimePin = {
    kind: target.runtime.kind,
    version: target.runtime.version,
    ...(target.runtime.lockHash ? { lockHash: target.runtime.lockHash } : {}),
    packages: stamp?.packages ?? target.runtime.packages,
  };
  const run: CallableFunctionServerRun = {
    at: new Date(),
    passed: runCases.length,
    failed: 0,
    results: runCases,
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
      trustLabel: callableFunctionTrustLabel(runCases),
      contract,
      sourcePins,
      pin: fn.pin,
      description: fn.description,
      ...(fn.sources?.length ? { sources: fn.sources } : {}),
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
