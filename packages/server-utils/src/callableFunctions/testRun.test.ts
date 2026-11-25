// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFunctionContract, type FunctionContract } from '@bike4mind/common';
import type { DispatchFunctionCallResult } from './dispatch';

const h = vi.hoisted(() => ({
  enabled: true,
  fn: null as Record<string, unknown> | null,
  artifact: null as Record<string, unknown> | null,
  read: null as unknown,
  readMs: 0,
  caseMs: 0,
  reads: [] as unknown[][],
  calls: [] as unknown[][],
  results: [] as unknown[],
  recorded: [] as unknown[][],
}));

vi.mock('./access', async () => {
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    assertCallableFunctionsEnabled: vi.fn(async () => {
      if (!h.enabled) throw new ForbiddenError('Callable functions are disabled');
    }),
  };
});
vi.mock('@bike4mind/database', () => ({
  // Filters as the repository does, so a call with the wrong owner finds another person's function.
  callableFunctionRepository: {
    findByIdForOwner: vi.fn(async (id: string, owner: { ownerType: string; ownerKey: string }) =>
      h.fn && h.fn.id === id && h.fn.ownerType === owner.ownerType && h.fn.ownerKey === owner.ownerKey ? h.fn : null
    ),
    recordCaseResults: vi.fn(async (...args: unknown[]) => {
      h.recorded.push(args);
      return true;
    }),
  },
  artifactRepository: { findOne: vi.fn(async () => h.artifact) },
  callableFunctionCallRepository: { record: vi.fn() },
}));
vi.mock('./dispatch', async importOriginal => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  readServerContract: vi.fn(async (...args: unknown[]) => {
    h.reads.push(args);
    vi.setSystemTime(Date.now() + h.readMs);
    return h.read;
  }),
  dispatchFunctionCall: vi.fn(async (...args: unknown[]) => {
    h.calls.push(args);
    const waitMs = (args[1] as { deadline: number }).deadline - Date.now();
    vi.setSystemTime(Date.now() + (h.caseMs < 0 ? waitMs : h.caseMs));
    return h.results.shift() ?? { outcome: 'timeout', reason: 'wait_exceeded', durationMs: waitMs, callId: 'call-x' };
  }),
}));

import { CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS, CALLABLE_FUNCTION_SURFACE_CAPS } from './dispatch';
import {
  CALLABLE_FUNCTION_TEST_CASE_MIN_MS,
  CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS,
  CALLABLE_FUNCTION_TEST_RUN_MARGIN_MS,
  callableFunctionCaseHash,
  callableFunctionTestRunBudget,
  runCallableFunctionTests,
} from './testRun';

const OWNER = { id: 'owner-1' };
const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const runner = vi.fn();

const contractWith = (tests: unknown[]): FunctionContract => {
  const parsed = parseFunctionContract({
    name: 'beam_midspan_deflection',
    description: 'Midspan deflection of a simply supported beam.',
    inputs: {
      type: 'object',
      additionalProperties: false,
      required: ['span'],
      properties: { span: { type: 'number', unit: 'm' } },
    },
    outputs: {
      type: 'object',
      additionalProperties: false,
      required: ['deflection'],
      properties: { deflection: { type: 'number', unit: 'm' } },
    },
    tests,
  });
  if (!parsed.ok) throw new Error('fixture contract must parse');
  return parsed.contract;
};
const CONTRACT = contractWith([
  { name: 'short span', input: { span: 2 }, expected: { deflection: 4 } },
  { name: 'long span', input: { span: 10 }, expected: { deflection: 20 }, tolerance: { abs: 0.5 } },
]);

const dispatched = (overrides: Partial<DispatchFunctionCallResult>): DispatchFunctionCallResult => ({
  outcome: 'ok',
  durationMs: 30,
  callId: 'call-1',
  ...overrides,
});

const caseArgs = (span: number) => ({ caller: OWNER, functionId: FUNCTION_ID, args: { span }, surface: 'test' });
const errorOf = async (promise: Promise<unknown>) => {
  const error = (await promise.then(
    () => null,
    (thrown: unknown) => thrown
  )) as { name: string; message: string; statusCode: number; additionalInfo?: unknown } | null;
  return (
    error && { name: error.name, message: error.message, statusCode: error.statusCode, info: error.additionalInfo }
  );
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h.enabled = true;
  h.fn = {
    id: FUNCTION_ID,
    ownerType: 'user',
    ownerKey: OWNER.id,
    userId: OWNER.id,
    enabled: true,
    state: 'draft',
    pin: { artifactId: 'a1', source: 'code' },
    contract: CONTRACT,
  };
  h.artifact = { id: 'a1', version: 1, deletedAt: null };
  h.read = { ok: true, contract: CONTRACT, callId: 'read-1' };
  h.readMs = 0;
  h.caseMs = 0;
  h.reads = [];
  h.calls = [];
  h.results = [];
  h.recorded = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runCallableFunctionTests', () => {
  it('reads the contract, runs each declared test through the dispatcher, and compares the outputs', async () => {
    h.results = [
      dispatched({ outputs: { deflection: 4 }, callId: 'call-1', durationMs: 31 }),
      dispatched({ outputs: { deflection: 21 }, callId: 'call-2', durationMs: 29 }),
    ];
    const deadline = Date.now() + 45_000;
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    expect(h.reads).toEqual([
      [
        { caller: OWNER, fn: h.fn, surface: 'test' },
        { runner, waitMs: CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS },
      ],
    ]);
    const options = { runner, contract: CONTRACT, deadline, minWaitMs: CALLABLE_FUNCTION_TEST_CASE_MIN_MS };
    expect(h.calls).toEqual([
      [caseArgs(2), options],
      [caseArgs(10), options],
    ]);
    expect(run).toMatchObject({ functionId: FUNCTION_ID, passed: 1, failed: 1, notRun: 0, contractCallId: 'read-1' });
    expect(run.results).toEqual([
      { name: 'short span', passed: true, outcome: 'ok', mismatch: null, durationMs: 31, callId: 'call-1' },
      {
        name: 'long span',
        passed: false,
        outcome: 'ok',
        mismatch: { path: 'deflection', expected: 20, actual: 21 },
        durationMs: 29,
        callId: 'call-2',
      },
    ]);
  });

  it('fails a case that timed out, with no mismatch to show', async () => {
    h.results = [
      dispatched({ outcome: 'timeout', callId: 'call-1' }),
      dispatched({ outputs: { deflection: 20.2 }, callId: 'call-2' }),
    ];
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    expect(run.results[0]).toMatchObject({ passed: false, outcome: 'timeout', mismatch: null, callId: 'call-1' });
    expect(run.results[1]).toMatchObject({ passed: true, mismatch: null });
  });

  it('answers 403 with the setting off and reads nothing', async () => {
    h.enabled = false;
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.reads).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("answers another owner's function exactly as a missing one, and runs neither's code", async () => {
    h.fn = { ...h.fn, ownerKey: 'someone-else', userId: 'someone-else' };
    const theirs = await errorOf(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner }));
    h.fn = null;
    const missing = await errorOf(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner }));
    expect(theirs).toEqual(missing);
    expect(theirs).toMatchObject({ statusCode: 404 });
    expect(h.reads).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['disabled', () => (h.fn = { ...h.fn, enabled: false })],
    ['source_deleted', () => (h.artifact = null)],
  ])('answers 409 not_callable for a %s function before reading the contract', async (status, arrange) => {
    arrange();
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'not_callable', status },
    });
    expect(h.reads).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('answers 503 when no runtime is configured, before reading', async () => {
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner: null })).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { code: 'runtime_unavailable' },
    });
    expect(h.reads).toEqual([]);
  });

  it.each([
    ['wait_exceeded', 'timeout', 'runtime_starting'],
    ['start_timeout', 'error', 'runtime_starting'],
    ['runtime_unavailable', 'error', 'runtime_unavailable'],
  ])('answers 503 when the read ends in %s, and runs no case', async (reason, outcome, code) => {
    h.read = { ok: false, outcome, reason, callId: 'read-1' };
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { code },
    });
    expect(h.calls).toEqual([]);
  });

  it('answers 422 when the code itself gives no contract', async () => {
    h.read = { ok: false, outcome: 'error', reason: 'contract_missing', callId: 'read-1' };
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 422,
      additionalInfo: { code: 'contract_unreadable', outcome: 'error', reason: 'contract_missing' },
    });
    expect(h.calls).toEqual([]);
  });

  it("answers 409 when the server's read differs from the saved contract", async () => {
    h.read = { ok: true, contract: { ...CONTRACT, tests: [{ name: 'other', input: { span: 1 }, expected: {} }] } };
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'contract_changed' },
    });
    expect(h.calls).toEqual([]);
  });

  it('compares the contracts canonically, so a saved copy in another key order still runs', async () => {
    const reordered = Object.fromEntries(Object.entries(CONTRACT).reverse()) as unknown as FunctionContract;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(CONTRACT));
    h.fn = { ...h.fn, contract: reordered };
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    expect(run.results).toHaveLength(2);
  });

  it('answers 400 when the code declares no tests', async () => {
    const { tests: _tests, ...untested } = CONTRACT;
    h.fn = { ...h.fn, contract: untested };
    h.read = { ok: true, contract: untested, callId: 'read-1' };
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { code: 'no_tests' },
    });
  });

  it('runs only the named tests, and refuses a name the code does not declare', async () => {
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner, tests: ['long span'] });
    expect(run.results.map(result => result.name)).toEqual(['long span']);
    expect(h.calls.map(([request]) => request)).toEqual([caseArgs(10)]);
    h.calls = [];
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner, tests: ['wide span'] })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { code: 'unknown_test', names: ['wide span'] },
    });
    expect(h.calls).toEqual([]);
  });
});

describe('the test run budget', () => {
  it('gives each case the run deadline and returns the cases it cannot reach as not run, with no call', async () => {
    h.readMs = 3_000;
    h.caseMs = 38_000;
    const deadline = Date.now() + 45_000;
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0][1]).toMatchObject({ deadline, minWaitMs: CALLABLE_FUNCTION_TEST_CASE_MIN_MS });
    expect(run).toMatchObject({ passed: 0, failed: 1, notRun: 1 });
    expect(run.results[1]).toEqual({
      name: 'long span',
      passed: false,
      outcome: 'not_run',
      reason: 'budget_exhausted',
      mismatch: null,
    });
  });

  it("returns a case as not run, with its row, when the dispatcher's reads left it too little time", async () => {
    h.results = [
      dispatched({ outcome: 'refused', reason: 'budget_exhausted', callId: 'call-1' }),
      dispatched({ outputs: { deflection: 20 }, callId: 'call-2' }),
    ];
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    expect(run).toMatchObject({ passed: 1, failed: 0, notRun: 1 });
    expect(run.results[0]).toEqual({
      name: 'short span',
      passed: false,
      outcome: 'not_run',
      reason: 'budget_exhausted',
      mismatch: null,
      callId: 'call-1',
    });
  });

  it('gives the read no more than what is left of a lowered budget', async () => {
    h.readMs = 2_000;
    h.caseMs = 2_000;
    const deadline = Date.now() + 8_000;
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner, budgetMs: 8_000 });
    expect(h.reads[0][1]).toEqual({ runner, waitMs: 8_000 });
    expect(h.calls[0][1]).toMatchObject({ deadline });
    expect(run.results.map(result => result.outcome)).toEqual(['timeout', 'not_run']);
  });

  it('never raises the budget past its ceiling', async () => {
    const deadline = Date.now() + CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS;
    await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner, budgetMs: 600_000 });
    expect(h.calls[0][1]).toMatchObject({ deadline });
    expect(callableFunctionTestRunBudget({ CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS: '8000' })).toBe(8_000);
    expect(callableFunctionTestRunBudget({ CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS: '600000' })).toBe(45_000);
    expect(callableFunctionTestRunBudget({ CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS: 'soon' })).toBe(45_000);
    expect(callableFunctionTestRunBudget({})).toBe(45_000);
  });

  it("fits twenty cases that each take their whole wait inside the web function's configured timeout", async () => {
    const web = readFileSync(fileURLToPath(new URL('../../../../infra/web.ts', import.meta.url)), 'utf8');
    const configured = /server:\s*\{\s*timeout:\s*'(\d+) seconds'/.exec(web);
    expect(configured).not.toBeNull();
    const routeLimitMs = Number(configured?.[1]) * 1000;

    const twenty = contractWith(
      Array.from({ length: 20 }, (_, index) => ({
        name: `case ${index}`,
        input: { span: index },
        expected: { deflection: 0 },
      }))
    );
    h.fn = { ...h.fn, contract: twenty };
    h.read = { ok: true, contract: twenty, callId: 'read-1' };
    h.readMs = CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS;
    h.caseMs = -1;
    const started = Date.now();
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    const spentMs = Date.now() - started;

    // A 15 s read leaves 30 s; the first case waits all of it, so the other 19 are not run.
    expect(spentMs).toBeLessThanOrEqual(CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS);
    expect(run.notRun).toBe(19);
    const total = CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS + CALLABLE_FUNCTION_TEST_RUN_MARGIN_MS;
    expect(total).toBeLessThanOrEqual(routeLimitMs);
    expect(CALLABLE_FUNCTION_CONTRACT_READ_WAIT_MS + CALLABLE_FUNCTION_TEST_CASE_MIN_MS).toBeLessThanOrEqual(
      CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS
    );
    for (const caps of Object.values(CALLABLE_FUNCTION_SURFACE_CAPS)) {
      expect(caps.waitMs + CALLABLE_FUNCTION_TEST_RUN_MARGIN_MS).toBeLessThanOrEqual(routeLimitMs);
    }
  });
});

describe('recording server results for promotion', () => {
  const LOCK = 'a'.repeat(64);
  const CONTENT_HASH = 'c'.repeat(64);
  const stamp = { runtime: { kind: 'pyodide-server', version: '0.25.1', lock_hash: LOCK }, packages: [] };
  const EXAMPLE = { name: 'handbook case', input: { span: 3 }, expected: { deflection: 6 }, citation: 'ref' };
  const entry = (testCase: { input: unknown; expected: unknown; tolerance?: unknown }, name: string) => ({
    caseHash: callableFunctionCaseHash(testCase as never),
    name,
    kind: name === EXAMPLE.name ? 'example' : 'test',
    passed: true,
    outcome: 'ok',
    durationMs: 5,
    callId: 'earlier',
    at: new Date(0),
  });

  it('records each test that ran on the runtime, a failure over an earlier pass, and keeps the example passes', async () => {
    const [shortSpan, longSpan] = CONTRACT.tests!;
    h.fn = {
      ...h.fn,
      pin: { artifactId: 'a1', version: 4, contentHash: CONTENT_HASH, source: 'code' },
      examples: [EXAMPLE],
      caseResults: {
        pinVersion: 4,
        contentHash: CONTENT_HASH,
        runtimeVersion: '0.25.1',
        lockHash: LOCK,
        cases: [
          entry(longSpan!, 'long span'),
          entry(EXAMPLE, EXAMPLE.name),
          entry({ input: { span: 99 }, expected: {} }, 'removed case'),
        ],
      },
    };
    h.read = { ...(h.read as object), runtime: { kind: 'pyodide-server', version: '0.25.1', lockHash: LOCK } };
    h.results = [
      dispatched({ outputs: { deflection: 4 }, callId: 'call-1', stamp: stamp as never }),
      dispatched({ outputs: { deflection: 30 }, callId: 'call-2', stamp: stamp as never }),
    ];
    await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    const [id, owner, results] = h.recorded[0]! as [string, unknown, { cases: { name: string }[] }];
    expect([id, owner]).toEqual([FUNCTION_ID, { ownerType: 'user', ownerKey: OWNER.id }]);
    expect(results).toMatchObject({
      pinVersion: 4,
      contentHash: CONTENT_HASH,
      runtimeVersion: '0.25.1',
      lockHash: LOCK,
    });
    const byName = Object.fromEntries(results.cases.map(item => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual(['handbook case', 'long span', 'short span']);
    expect(byName['short span']).toMatchObject({ kind: 'test', passed: true, callId: 'call-1' });
    expect(byName['long span']).toMatchObject({ kind: 'test', passed: false, callId: 'call-2' });
    expect(byName['handbook case']).toMatchObject({ kind: 'example', passed: true, callId: 'earlier' });
    expect(callableFunctionCaseHash(shortSpan!)).toBe(callableFunctionCaseHash({ ...shortSpan!, name: 'renamed' }));
  });

  it('records nothing for a case without a stamp on the runtime that read the contract', async () => {
    h.read = { ...(h.read as object), runtime: { kind: 'pyodide-server', version: '0.25.1', lockHash: LOCK } };
    h.results = [dispatched({ outputs: { deflection: 4 } }), dispatched({ outcome: 'timeout' })];
    await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    expect(h.recorded).toEqual([]);
  });
});
