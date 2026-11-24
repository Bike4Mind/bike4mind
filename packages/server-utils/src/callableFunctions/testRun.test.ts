// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFunctionContract, type FunctionContract } from '@bike4mind/common';
import type { DispatchFunctionCallResult } from './dispatch';

const h = vi.hoisted(() => ({
  enabled: true,
  fn: null as Record<string, unknown> | null,
  artifact: null as Record<string, unknown> | null,
  read: null as unknown,
  calls: [] as unknown[][],
  results: [] as unknown[],
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
  callableFunctionRepository: { findByIdForOwner: vi.fn(async () => h.fn) },
  artifactRepository: { findOne: vi.fn(async () => h.artifact) },
}));
vi.mock('./dispatch', () => ({
  readServerContract: vi.fn(async () => h.read),
  dispatchFunctionCall: vi.fn(async (...args: unknown[]) => {
    h.calls.push(args);
    return h.results.shift();
  }),
}));

import { runCallableFunctionTests } from './testRun';

const OWNER = { id: 'owner-1' };
const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const runner = vi.fn();

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
  tests: [
    { name: 'short span', input: { span: 2 }, expected: { deflection: 4 } },
    { name: 'long span', input: { span: 10 }, expected: { deflection: 20 }, tolerance: { abs: 0.5 } },
  ],
});
if (!parsed.ok) throw new Error('fixture contract must parse');
const CONTRACT: FunctionContract = parsed.contract;

const dispatched = (overrides: Partial<DispatchFunctionCallResult>): DispatchFunctionCallResult => ({
  outcome: 'ok',
  durationMs: 30,
  callId: 'call-1',
  ...overrides,
});

beforeEach(() => {
  h.enabled = true;
  h.fn = {
    id: FUNCTION_ID,
    enabled: true,
    state: 'draft',
    pin: { artifactId: 'a1', source: 'code' },
    contract: CONTRACT,
  };
  h.artifact = { id: 'a1', version: 1, deletedAt: null };
  h.read = { ok: true, contract: CONTRACT };
  h.calls = [];
  h.results = [];
});

describe('runCallableFunctionTests', () => {
  it('runs each declared test through the dispatcher and compares the outputs', async () => {
    h.results = [
      dispatched({ outputs: { deflection: 4 }, callId: 'call-1', durationMs: 31 }),
      dispatched({ outputs: { deflection: 21 }, callId: 'call-2', durationMs: 29 }),
    ];
    const run = await runCallableFunctionTests(OWNER, FUNCTION_ID, { runner });
    expect(h.calls).toEqual([
      [
        { caller: OWNER, functionId: FUNCTION_ID, args: { span: 2 }, surface: 'test' },
        { runner, contract: CONTRACT },
      ],
      [
        { caller: OWNER, functionId: FUNCTION_ID, args: { span: 10 }, surface: 'test' },
        { runner, contract: CONTRACT },
      ],
    ]);
    expect(run).toMatchObject({ functionId: FUNCTION_ID, passed: 1, failed: 1 });
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
    expect(h.calls).toEqual([]);
  });

  it("answers 404 for a function that is not the caller's", async () => {
    h.fn = null;
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ['disabled', () => (h.fn = { ...h.fn, enabled: false })],
    ['source_deleted', () => (h.artifact = null)],
  ])('answers 409 not_callable for a %s function before reading the contract', async (status, arrange) => {
    arrange();
    h.read = null;
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: { code: 'not_callable', status },
    });
    expect(h.calls).toEqual([]);
  });

  it('answers 503 when no runtime is configured', async () => {
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner: null })).rejects.toMatchObject({
      statusCode: 503,
      additionalInfo: { code: 'runtime_unavailable' },
    });
  });

  it('answers 422 when the server cannot read the contract', async () => {
    h.read = { ok: false, outcome: 'timeout' };
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 422,
      additionalInfo: { code: 'contract_unreadable', outcome: 'timeout' },
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

  it('answers 400 when the code declares no tests', async () => {
    const { tests: _tests, ...untested } = CONTRACT;
    h.fn = { ...h.fn, contract: untested };
    h.read = { ok: true, contract: untested };
    await expect(runCallableFunctionTests(OWNER, FUNCTION_ID, { runner })).rejects.toMatchObject({
      statusCode: 400,
      additionalInfo: { code: 'no_tests' },
    });
  });
});
