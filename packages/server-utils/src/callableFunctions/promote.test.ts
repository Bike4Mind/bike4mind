// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  },
  artifactRepository: { findOne: vi.fn(async () => h.artifact) },
}));
vi.mock('./dispatch', () => ({
  readServerContract: vi.fn(async () => h.read),
  dispatchFunctionCall: vi.fn(async (...args: unknown[]) => {
    h.calls.push(args);
    return h.results.shift();
  }),
}));

import { promoteCallableFunction } from './promote';

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

beforeEach(() => {
  h.enabled = true;
  h.fn = {
    id: FUNCTION_ID,
    enabled: true,
    state: 'draft',
    pin: { artifactId: 'a1', version: 2, source: 'code' },
    contract: CONTRACT,
    updatedAt: UPDATED_AT,
  };
  h.artifact = { id: 'a1', version: 2, deletedAt: null };
  h.read = { ok: true, contract: CONTRACT };
  h.calls = [];
  h.results = [];
  h.promoteArgs = [];
  h.promoted = true;
  h.owners = [];
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
    h.read = { ok: true, contract: contractOf({ stress: { type: 'number', unit: 'Pa' } }) };
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
    h.read = { ok: true, contract: untested };
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
});
