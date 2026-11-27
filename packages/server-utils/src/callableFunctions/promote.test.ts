// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFunctionContract, type FunctionContract } from '@bike4mind/common';
import type { CallableFunctionStamp, DispatchFunctionCallResult } from './dispatch';

const h = vi.hoisted(() => ({
  enabled: true,
  fn: null as Record<string, unknown> | null,
  artifact: null as Record<string, unknown> | null,
  read: null as unknown,
  calls: [] as unknown[][],
  results: [] as unknown[],
  promoteArgs: [] as unknown[][],
  promoted: true,
  owners: [] as unknown[],
  recorded: [] as unknown[][],
  caseMs: 0,
  dropLastResult: false,
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
  callableFunctionRepository: {
    findByIdForOwner: vi.fn(async (_id: string, owner: unknown) => {
      h.owners.push(owner);
      return h.fn;
    }),
    promote: vi.fn(async (...args: unknown[]) => {
      h.promoteArgs.push(args);
      if (!h.promoted) return null;
      const update = args[3] as { seq: number; trustLabel: string; runtime: unknown; lastServerRun: unknown };
      const pin = (h.fn as { pin: Record<string, unknown> }).pin;
      return {
        ...h.fn,
        state: 'live',
        trustLabel: update.trustLabel,
        lastServerRun: update.lastServerRun,
        pin: { ...pin, seq: update.seq, runtime: update.runtime },
      };
    }),
    recordCaseResults: vi.fn(async (...args: unknown[]) => {
      h.recorded.push(args);
      return true;
    }),
  },
  artifactRepository: { findOne: vi.fn(async () => h.artifact) },
}));
vi.mock('./dispatch', async importOriginal => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  readServerContract: vi.fn(async () => h.read),
  dispatchFunctionCall: vi.fn(async (...args: unknown[]) => {
    h.calls.push(args);
    vi.setSystemTime(Date.now() + h.caseMs);
    return h.results.shift();
  }),
}));
vi.mock('./testRun', async importOriginal => {
  const actual = await importOriginal<typeof import('./testRun')>();
  return {
    ...actual,
    runServerCases: vi.fn(async (...args: Parameters<typeof actual.runServerCases>) => {
      const results = await actual.runServerCases(...args);
      return h.dropLastResult ? results.slice(0, -1) : results;
    }),
  };
});

import { promoteCallableFunction } from './promote';
import {
  CALLABLE_FUNCTION_TEST_CASE_MIN_MS,
  CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS,
  callableFunctionCaseHash,
} from './testRun';

const OWNER = { id: 'owner-1' };
const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const UPDATED_AT = new Date('2026-11-20T10:00:00.000Z');
const LOCK = 'a'.repeat(64);
const runner = vi.fn();

const contractOf = (outputs: Record<string, unknown>): FunctionContract => {
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
      properties: { deflection: { type: 'number', unit: 'm' }, ...outputs },
    },
    tests: [{ name: 'short span', input: { span: 2 }, expected: { deflection: 4 } }],
  });
  if (!parsed.ok) throw new Error('fixture contract must parse');
  return parsed.contract;
};
const CONTRACT = contractOf({});
const EXAMPLE = {
  name: 'handbook case',
  input: { span: 3 },
  expected: { deflection: 6 },
  tolerance: { rel: 1e-9 },
  citation: 'https://data.example.com/beams/table-3',
};

const STAMP = {
  function_id: FUNCTION_ID,
  runtime: { kind: 'pyodide-server', version: '0.25.1', lock_hash: LOCK },
  packages: [{ name: 'numpy', version: '1.26.4' }],
} as unknown as CallableFunctionStamp;
const dispatched = (overrides: Partial<DispatchFunctionCallResult>): DispatchFunctionCallResult => ({
  outcome: 'ok',
  durationMs: 30,
  callId: 'call-1',
  stamp: STAMP,
  ...overrides,
});

const CONTENT_HASH = 'c'.repeat(64);
const RUNTIME = { kind: 'pyodide-server', version: '0.25.1', lockHash: LOCK, packages: STAMP.packages };
const readOf = (contract: unknown) => ({ ok: true, contract, callId: 'read-1', runtime: RUNTIME });
const SECOND_EXAMPLE = { ...EXAMPLE, name: 'second case', input: { span: 5 }, expected: { deflection: 10 } };
const TEST_CASE = CONTRACT.tests![0]!;
const passOf = (testCase: typeof TEST_CASE, overrides: Record<string, unknown> = {}) => ({
  caseHash: callableFunctionCaseHash(testCase),
  name: testCase.name,
  kind: 'test',
  passed: true,
  outcome: 'ok',
  durationMs: 12,
  callId: 'earlier-call',
  at: UPDATED_AT,
  ...overrides,
});
const recordOf = (cases: unknown[], overrides: Record<string, unknown> = {}) => ({
  pinVersion: 2,
  contentHash: CONTENT_HASH,
  runtimeVersion: RUNTIME.version,
  lockHash: LOCK,
  cases,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  h.enabled = true;
  h.fn = {
    id: FUNCTION_ID,
    enabled: true,
    state: 'draft',
    pin: { artifactId: 'a1', version: 2, contentHash: CONTENT_HASH, source: 'code' },
    contract: CONTRACT,
    updatedAt: UPDATED_AT,
  };
  h.artifact = { id: 'a1', version: 2, deletedAt: null };
  h.read = readOf(CONTRACT);
  h.calls = [];
  h.results = [];
  h.promoteArgs = [];
  h.promoted = true;
  h.owners = [];
  h.recorded = [];
  h.caseMs = 0;
  h.dropLastResult = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('promoteCallableFunction', () => {
  it('promotes with declared tests only as live and unverified, writing every protected field', async () => {
    h.results = [dispatched({ outputs: { deflection: 4 } })];
    const promotion = await promoteCallableFunction(OWNER, FUNCTION_ID, { runner });
    expect(h.calls).toHaveLength(1);
    expect(h.promoteArgs).toHaveLength(1);
    const [id, owner, expected, update] = h.promoteArgs[0]!;
    expect([id, owner, expected]).toEqual([
      FUNCTION_ID,
      { ownerType: 'user', ownerKey: OWNER.id },
      { updatedAt: UPDATED_AT },
    ]);
    expect(update).toMatchObject({
      seq: 1,
      trustLabel: 'unverified',
      contract: CONTRACT,
      runtime: {
        kind: 'pyodide-server',
        version: '0.25.1',
        lockHash: LOCK,
        packages: [{ name: 'numpy', version: '1.26.4' }],
      },
      lastServerRun: {
        passed: 1,
        failed: 0,
        results: [{ name: 'short span', kind: 'test', passed: true, outcome: 'ok', callId: 'call-1' }],
        stamp: STAMP,
      },
    });
    expect(promotion.function).toMatchObject({ state: 'live', trustLabel: 'unverified', pin: { seq: 1 } });
  });

  it('fetches a pinned source once, runs the cases on those bytes, and freezes its hash', async () => {
    const body = Buffer.from('x,y\n1,2\n');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const fetcher = vi.fn(async () => ({ body, sha256, bytes: body.length, fetchedAt: '2026-11-20T10:00:00.000Z' }));
    const storage = { uploadStream: vi.fn(async () => undefined) };
    h.fn = { ...h.fn, sources: [{ name: 'base.csv', url: 'https://data.example.com/base.csv', mode: 'pinned' }] };
    h.results = [dispatched({ outputs: { deflection: 4 } })];
    const sources = {
      fetcher,
      storage: storage as never,
      origins: ['https://data.example.com'],
      limits: { fileBytes: 1024, totalBytes: 4096 },
    };

    await promoteCallableFunction(OWNER, FUNCTION_ID, { runner, sources });

    const frozen = [{ name: 'base.csv', sha256, bytes: body.length, fetchedAt: new Date('2026-11-20T10:00:00.000Z') }];
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storage.uploadStream).toHaveBeenCalledWith(
      expect.anything(),
      `data/${FUNCTION_ID}/${sha256}`,
      body.length,
      expect.anything()
    );
    expect((h.calls[0]![1] as { sources: { sourcePins: unknown } }).sources.sourcePins).toEqual(frozen);
    expect(h.promoteArgs[0]![3]).toMatchObject({ sourcePins: frozen });
  });

  it('promotes as verified when a worked example passes, after the tests, at the next sequence', async () => {
    h.fn = { ...h.fn, state: 'live', examples: [EXAMPLE], promoted: { seq: 1, contract: CONTRACT, at: UPDATED_AT } };
    h.results = [
      dispatched({ outputs: { deflection: 4 }, callId: 'call-1' }),
      dispatched({ outputs: { deflection: 6 }, callId: 'call-2' }),
    ];
    const promotion = await promoteCallableFunction(OWNER, FUNCTION_ID, { runner });
    expect(h.calls.map(call => (call[0] as { args: unknown }).args)).toEqual([{ span: 2 }, { span: 3 }]);
    expect(h.promoteArgs[0]![3]).toMatchObject({
      seq: 2,
      trustLabel: 'verified',
      lastServerRun: {
        results: [
          { name: 'short span', kind: 'test', passed: true },
          { name: 'handbook case', kind: 'example', passed: true, callId: 'call-2' },
        ],
      },
    });
    expect(promotion.function).toMatchObject({ state: 'live', trustLabel: 'verified', pin: { seq: 2 } });
  });

  it('refuses when the contract the server reads differs from the stored one, running nothing', async () => {
    h.read = readOf(contractOf({ stress: { type: 'number', unit: 'Pa' } }));
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'contract_changed' },
    });
    expect(h.calls).toEqual([]);
    expect(h.promoteArgs).toEqual([]);
  });

  it('refuses a breaking change against the last promoted contract, naming the field', async () => {
    const promotedContract = contractOf({ stress: { type: 'number', unit: 'Pa' } });
    h.fn = { ...h.fn, promoted: { seq: 1, contract: promotedContract, at: UPDATED_AT } };
    const refusal = promoteCallableFunction(OWNER, FUNCTION_ID, { runner });
    await expect(refusal).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Output stress was removed since promotion 1'),
      additionalInfo: {
        code: 'breaking_change',
        changes: [expect.objectContaining({ path: 'outputs.stress', kind: 'removed' })],
      },
    });
    expect(h.calls).toEqual([]);
    expect(h.promoteArgs).toEqual([]);
  });

  it('refuses when a declared test fails, after running every case, and writes nothing', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE] };
    h.results = [
      dispatched({ outputs: { deflection: 5 }, callId: 'call-1' }),
      dispatched({ outputs: { deflection: 6 }, callId: 'call-2' }),
    ];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      message: 'Test "short span" failed on the server: output deflection expected 4, got 5.',
      additionalInfo: { code: 'test_failed' },
    });
    expect(h.calls).toHaveLength(2);
    expect(h.promoteArgs).toEqual([]);
  });

  it('refuses when a worked example fails, naming it', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE] };
    h.results = [dispatched({ outputs: { deflection: 4 } }), dispatched({ outcome: 'timeout', callId: 'call-2' })];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      message: 'Worked example "handbook case" failed on the server: stopped at the time limit.',
      additionalInfo: { code: 'example_failed' },
    });
    expect(h.promoteArgs).toEqual([]);
  });

  it('answers 404 to a caller who is not the owner, looking only among their own functions', async () => {
    h.fn = null;
    await expect(promoteCallableFunction({ id: 'someone-else' }, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.owners).toEqual([{ ownerType: 'user', ownerKey: 'someone-else' }]);
    expect(h.calls).toEqual([]);
  });

  it('answers 403 with the setting off and reads nothing', async () => {
    h.enabled = false;
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.owners).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('refuses a function with no tests and no worked examples', async () => {
    const { tests: _tests, ...untested } = CONTRACT;
    h.fn = { ...h.fn, contract: untested };
    h.read = readOf(untested);
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { code: 'no_cases' },
    });
  });

  it('refuses when the record changed while the cases ran', async () => {
    h.results = [dispatched({ outputs: { deflection: 4 } })];
    h.promoted = false;
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'version_changed' },
    });
  });

  it('refuses a promoted contract it cannot read, running nothing', async () => {
    h.fn = { ...h.fn, promoted: { seq: 1, contract: { name: 7 }, at: UPDATED_AT } };
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('The promoted contract cannot be read since promotion 1'),
      additionalInfo: { code: 'breaking_change' },
    });
    expect(h.calls).toEqual([]);
    expect(h.promoteArgs).toEqual([]);
  });
});

describe('promotion within the budget', () => {
  it('refuses with cases_left when the budget runs out, naming the cases not run, and never writes', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE, SECOND_EXAMPLE] };
    h.caseMs = 30_000;
    h.results = [
      dispatched({ outputs: { deflection: 4 }, callId: 'call-1' }),
      dispatched({ outputs: { deflection: 6 }, callId: 'call-2' }),
    ];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      message: '2 of 3 cases have passed on the server for this version. Promote again to run the other 1.',
      additionalInfo: { code: 'cases_left', passed: 2, total: 3, left: [{ kind: 'example', name: 'second case' }] },
    });
    expect(h.calls).toHaveLength(2);
    expect(h.promoteArgs).toEqual([]);
    expect(h.recorded[0]![2]).toMatchObject({
      pinVersion: 2,
      contentHash: CONTENT_HASH,
      runtimeVersion: '0.25.1',
      lockHash: LOCK,
      cases: [
        { name: 'short span', kind: 'test', passed: true, callId: 'call-1' },
        { name: 'handbook case', kind: 'example', passed: true, callId: 'call-2' },
      ],
    });
  });

  it('counts a case the budget cut short as left, not failed, and records nothing for it', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE] };
    h.caseMs = 35_000;
    h.results = [
      dispatched({ outputs: { deflection: 4 }, callId: 'call-1' }),
      dispatched({
        outcome: 'timeout',
        callId: 'call-2',
        stamp: { ...STAMP, runtime: { ...STAMP.runtime, lock_hash: null } } as CallableFunctionStamp,
      }),
    ];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      additionalInfo: { code: 'cases_left', passed: 1, total: 2, left: [{ kind: 'example', name: 'handbook case' }] },
    });
    expect(h.calls).toHaveLength(2);
    expect(h.promoteArgs).toEqual([]);
    expect((h.recorded[0]![2] as { cases: { name: string }[] }).cases.map(entry => entry.name)).toEqual(['short span']);
  });

  it('counts a case that timed out on its own limit well inside the budget as failed, not left', async () => {
    h.caseMs = 30_000;
    h.results = [dispatched({ outcome: 'timeout', durationMs: 30_000 })];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      additionalInfo: { code: 'test_failed' },
    });
    expect(h.promoteArgs).toEqual([]);
  });

  it('gives each case the run deadline and counts a budget_exhausted refusal as left, not failed', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE] };
    const deadline = Date.now() + CALLABLE_FUNCTION_TEST_RUN_BUDGET_MS;
    const refused: DispatchFunctionCallResult = {
      outcome: 'refused',
      reason: 'budget_exhausted',
      durationMs: 0,
      callId: 'call-2',
    };
    h.results = [dispatched({ outputs: { deflection: 4 }, callId: 'call-1' }), refused];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      additionalInfo: { code: 'cases_left', passed: 1, total: 2, left: [{ kind: 'example', name: 'handbook case' }] },
    });
    expect(h.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ deadline, minWaitMs: CALLABLE_FUNCTION_TEST_CASE_MIN_MS }),
      expect.objectContaining({ deadline, minWaitMs: CALLABLE_FUNCTION_TEST_CASE_MIN_MS }),
    ]);
    expect(h.promoteArgs).toEqual([]);
    expect((h.recorded[0]![2] as { cases: { name: string }[] }).cases.map(entry => entry.name)).toEqual(['short span']);
  });

  it('refuses with cases_left when the run returns fewer results than cases, and never writes', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE] };
    h.dropLastResult = true;
    h.results = [dispatched({ outputs: { deflection: 4 } }), dispatched({ outputs: { deflection: 6 } })];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      additionalInfo: { code: 'cases_left', passed: 1, total: 2, left: [{ kind: 'example', name: 'handbook case' }] },
    });
    expect(h.promoteArgs).toEqual([]);
  });

  it('reuses passes recorded on this pin, code, and runtime, and runs only the missing cases', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE], caseResults: recordOf([passOf(TEST_CASE)]) };
    h.results = [dispatched({ outputs: { deflection: 6 }, callId: 'call-2' })];
    await promoteCallableFunction(OWNER, FUNCTION_ID, { runner });
    expect(h.calls.map(call => (call[0] as { args: unknown }).args)).toEqual([{ span: 3 }]);
    expect(h.promoteArgs[0]![3]).toMatchObject({
      trustLabel: 'verified',
      lastServerRun: {
        passed: 2,
        results: [
          { name: 'short span', kind: 'test', passed: true, callId: 'earlier-call' },
          { name: 'handbook case', kind: 'example', passed: true, callId: 'call-2' },
        ],
      },
    });
  });

  it('finishes a suite over two promotions, running each case once', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE, SECOND_EXAMPLE] };
    h.caseMs = 30_000;
    h.results = [dispatched({ outputs: { deflection: 4 } }), dispatched({ outputs: { deflection: 6 } })];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      additionalInfo: { code: 'cases_left' },
    });
    h.fn = { ...h.fn, caseResults: h.recorded[0]![2] };
    h.results = [dispatched({ outputs: { deflection: 10 }, callId: 'call-3' })];
    await promoteCallableFunction(OWNER, FUNCTION_ID, { runner });
    expect(h.calls).toHaveLength(3);
    expect(h.promoteArgs[0]![3]).toMatchObject({ lastServerRun: { passed: 3, failed: 0 } });
  });

  it.each([
    ['the pin version', { pinVersion: 1 }, {}],
    ['the code hash', { contentHash: 'd'.repeat(64) }, {}],
    ['the runtime version', { runtimeVersion: '0.24.0' }, {}],
    ['the lock hash', { lockHash: 'b'.repeat(64) }, {}],
    ['the case', {}, { expected: { deflection: 5 } }],
  ])('runs a recorded pass again when %s changed', async (_what, recordChange, caseChange) => {
    const recordedCase = { ...TEST_CASE, ...caseChange };
    h.fn = { ...h.fn, caseResults: recordOf([passOf(recordedCase)], recordChange) };
    h.results = [dispatched({ outputs: { deflection: 4 } })];
    await promoteCallableFunction(OWNER, FUNCTION_ID, { runner });
    expect(h.calls).toHaveLength(1);
  });

  it('runs a recorded pass again on a function with sources', async () => {
    h.fn = {
      ...h.fn,
      sources: [{ name: 'rates.csv', url: 'https://data.example.com/rates.csv', mode: 'live' }],
      caseResults: recordOf([passOf(TEST_CASE)]),
    };
    h.results = [dispatched({ outputs: { deflection: 4 } })];
    await promoteCallableFunction(OWNER, FUNCTION_ID, { runner });
    expect(h.calls).toHaveLength(1);
  });

  it('never reuses a recorded failure', async () => {
    h.fn = { ...h.fn, caseResults: recordOf([passOf(TEST_CASE, { passed: false, outcome: 'error' })]) };
    h.results = [dispatched({ outputs: { deflection: 5 } })];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      additionalInfo: { code: 'test_failed' },
    });
    expect(h.calls).toHaveLength(1);
    expect(h.recorded[0]![2]).toMatchObject({ cases: [{ name: 'short span', passed: false }] });
  });

  it('refuses when a case ran on another runtime than the contract read, and records only what matched', async () => {
    h.fn = { ...h.fn, examples: [EXAMPLE] };
    const moved = { ...STAMP, runtime: { ...STAMP.runtime, lock_hash: 'b'.repeat(64) } } as CallableFunctionStamp;
    h.results = [dispatched({ outputs: { deflection: 4 } }), dispatched({ outputs: { deflection: 6 }, stamp: moved })];
    await expect(promoteCallableFunction(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'runtime_changed' },
    });
    expect(h.promoteArgs).toEqual([]);
    expect(h.recorded[0]![2]).toMatchObject({ cases: [{ name: 'short span' }] });
    expect((h.recorded[0]![2] as { cases: unknown[] }).cases).toHaveLength(1);
  });
});
