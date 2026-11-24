// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  parseFunctionContract,
  type FunctionContract,
  type ICallableFunctionCall,
} from '@bike4mind/common';
import type { CallableFunctionRunPayload, CallableFunctionRunResult } from './runtimeParent';

const h = vi.hoisted(() => ({
  enabled: true,
  fn: null as Record<string, unknown> | null,
  artifact: null as Record<string, unknown> | null,
  rows: [] as Record<string, unknown>[],
  reads: [] as string[],
}));

vi.mock('./access', () => ({
  resolveCallableFunctionsEnabled: vi.fn(async () => {
    h.reads.push('setting');
    return h.enabled;
  }),
}));
vi.mock('@bike4mind/database', () => ({
  callableFunctionRepository: {
    findById: vi.fn(async () => {
      h.reads.push('record');
      return h.fn;
    }),
  },
  artifactRepository: {
    findOne: vi.fn(async () => {
      h.reads.push('head');
      return h.artifact;
    }),
  },
  callableFunctionCallRepository: {
    record: vi.fn(async (row: Record<string, unknown>) => {
      h.rows.push(row);
      return { ...row, id: `call-${h.rows.length}` };
    }),
  },
}));

import { buildCallableFunctionStamp, dispatchFunctionCall, functionInputHash, readServerContract } from './dispatch';

const OWNER = { id: 'owner-1' };
const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const SOURCE = 'FUNCTION = {}\n\ndef run(load, span):\n    return {"deflection": load * span}\n';
const HASH = createHash('sha256').update(SOURCE).digest('hex');
const LOCK = 'b'.repeat(64);

const parsed = parseFunctionContract({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span'],
    properties: {
      load: { type: 'number', unit: 'N/m' },
      span: { type: 'number', unit: 'm' },
      note: { type: 'string' },
      samples: { type: 'array', items: { type: 'number', unit: 'm' } },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: {
      deflection: { type: 'number', unit: 'm' },
      label: { type: 'string' },
      samples: { type: 'array', items: { type: 'number', unit: 'm' } },
    },
  },
});
if (!parsed.ok) throw new Error('fixture contract must parse');
const CONTRACT: FunctionContract = parsed.contract;

const record = (overrides: Record<string, unknown> = {}) => ({
  id: FUNCTION_ID,
  ownerType: 'user',
  ownerKey: OWNER.id,
  userId: OWNER.id,
  slug: CONTRACT.name,
  state: 'draft',
  enabled: true,
  pin: { artifactId: 'artifact-1', version: 3, contentHash: HASH, source: SOURCE, pinnedAt: new Date() },
  contract: CONTRACT,
  ...overrides,
});

const ARGS = { load: 1234.5, span: 6.789 };
// Valid against the contract and a little over 5 MB as JSON.
const OVERSIZE = new Array(500_000).fill(0.123456789);
const ok = (overrides: Partial<CallableFunctionRunResult> = {}): CallableFunctionRunResult => ({
  outcome: 'ok',
  outputs: { deflection: 8381.0 },
  durationMs: 40,
  initMs: 900,
  runtime: { lockHash: LOCK, packages: [{ name: 'numpy', version: '1.26.4' }] },
  ...overrides,
});

const runnerOf = (result: CallableFunctionRunResult | (() => Promise<CallableFunctionRunResult>)) =>
  vi.fn(async (_payload: CallableFunctionRunPayload) => (typeof result === 'function' ? result() : result));

const call = (overrides: Partial<Parameters<typeof dispatchFunctionCall>[0]> = {}) => ({
  caller: OWNER,
  functionId: FUNCTION_ID,
  args: ARGS as unknown,
  surface: 'test' as const,
  ...overrides,
});

const onlyRow = () => {
  expect(h.rows).toHaveLength(1);
  return h.rows[0] as unknown as ICallableFunctionCall;
};

beforeEach(() => {
  h.enabled = true;
  h.fn = record();
  h.artifact = { id: 'artifact-1', version: 3, deletedAt: null };
  h.rows = [];
  h.reads = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dispatchFunctionCall refusals, in order', () => {
  it('refuses with the setting off before the record is read', async () => {
    h.enabled = false;
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call(), { runner });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'setting_off', callId: 'call-1' });
    expect(h.reads).toEqual(['setting']);
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow()).toMatchObject({ outcome: 'refused', reason: 'setting_off', callerUserId: OWNER.id });
  });

  it('refuses a missing record before reading the artifact', async () => {
    h.fn = null;
    const result = await dispatchFunctionCall(call(), { runner: runnerOf(ok()) });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(h.reads).toEqual(['setting', 'record']);
    expect(onlyRow()).toMatchObject({ functionId: FUNCTION_ID, reason: 'not_found' });
    expect(onlyRow().ownerUserId).toBeUndefined();
  });

  it('refuses anyone but the owner before reading the status', async () => {
    const result = await dispatchFunctionCall(call({ caller: { id: 'stranger-1' } }), { runner: runnerOf(ok()) });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not_caller' });
    expect(h.reads).toEqual(['setting', 'record']);
    expect(onlyRow()).toMatchObject({ ownerUserId: OWNER.id, callerUserId: 'stranger-1', codeHash: HASH });
  });

  it('refuses a turned-off function before checking the inputs', async () => {
    h.fn = record({ enabled: false });
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ args: { load: 'heavy' } }), { runner });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses a function whose artifact was deleted', async () => {
    h.artifact = null;
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call(), { runner });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'source_deleted' });
    expect(h.reads).toEqual(['setting', 'record', 'head']);
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses inputs that break the contract, before measuring their size', async () => {
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ args: { load: 'heavy', samples: OVERSIZE } }), { runner });
    expect(result.outcome).toBe('input_invalid');
    expect(result.reason).toBeUndefined();
    expect(result.problems?.map(problem => problem.path)).toEqual(['span', 'load']);
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow()).toMatchObject({ outcome: 'input_invalid' });
  });

  it('refuses inputs over the surface cap', async () => {
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ args: { ...ARGS, samples: OVERSIZE } }), { runner });
    expect(result).toMatchObject({ outcome: 'input_invalid', reason: 'input_too_large' });
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow().inputBytes).toBeGreaterThan(5 * 1024 * 1024);
  });

  it('refuses when no runtime is configured', async () => {
    const result = await dispatchFunctionCall(call(), { runner: null });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'runtime_unavailable' });
    expect(onlyRow()).toMatchObject({ outcome: 'refused', reason: 'runtime_unavailable' });
  });
});

describe('dispatchFunctionCall outcomes', () => {
  it('runs the pinned code with the surface output cap and returns the outputs with a stamp', async () => {
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ surface: 'chat' }), { runner });
    expect(result).toMatchObject({ outcome: 'ok', outputs: { deflection: 8381.0 }, callId: 'call-1' });
    expect(runner).toHaveBeenCalledWith({
      op: 'call',
      code: SOURCE,
      contract: CONTRACT,
      params: ARGS,
      limits: { timeoutMs: 30_000, outputBytes: 256 * 1024 },
    });
    expect(onlyRow()).toMatchObject({
      outcome: 'ok',
      surface: 'chat',
      inputHash: functionInputHash(ARGS),
      runtime: { kind: 'pyodide-server', version: '0.25.1', lockHash: LOCK },
      initMs: 900,
      durationMs: 40,
    });
  });

  it.each([
    ['timeout', ok({ outcome: 'timeout', outputs: undefined })],
    ['memory', ok({ outcome: 'memory', outputs: undefined })],
    ['error', ok({ outcome: 'error', outputs: undefined, errorClass: 'ZeroDivisionError' })],
  ] as const)('records the runtime outcome %s with a stamp', async (outcome, run) => {
    const result = await dispatchFunctionCall(call(), { runner: runnerOf(run) });
    expect(result.outcome).toBe(outcome);
    expect(result.outputs).toBeUndefined();
    expect(result.stamp?.input_hash).toBe(functionInputHash(ARGS));
    expect(onlyRow()).toMatchObject({ outcome, ...(run.errorClass ? { errorClass: run.errorClass } : {}) });
  });

  it('checks the outputs again and refuses ones that break the contract', async () => {
    const result = await dispatchFunctionCall(call(), { runner: runnerOf(ok({ outputs: { deflection: 'far' } })) });
    expect(result.outcome).toBe('output_invalid');
    expect(result.problems).toEqual([{ path: 'deflection', message: 'must be a number' }]);
    expect(result.outputs).toBeUndefined();
  });

  it('refuses outputs over the surface cap', async () => {
    const big = ok({ outputs: { deflection: 1, samples: new Array(30_000).fill(0.123456789) } });
    const result = await dispatchFunctionCall(call({ surface: 'chat' }), { runner: runnerOf(big) });
    expect(result).toMatchObject({ outcome: 'output_too_large', reason: 'result_too_large' });
    expect(result.outputs).toBeUndefined();
  });

  it('records an error when the runner throws', async () => {
    const result = await dispatchFunctionCall(call(), {
      runner: vi.fn(async () => {
        throw new Error('Callable function runtime invocation failed');
      }),
    });
    expect(result).toMatchObject({ outcome: 'error', reason: 'runtime_unavailable' });
    expect(onlyRow()).toMatchObject({ outcome: 'error', reason: 'runtime_unavailable' });
  });

  it('stops waiting at the hard deadline when the runner never answers', async () => {
    vi.useFakeTimers();
    const pending = dispatchFunctionCall(call(), {
      runner: vi.fn(() => new Promise<never>(() => {})),
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000 + 60_000 + 15_000);
    await expect(pending).resolves.toMatchObject({ outcome: 'error', reason: 'no_reply' });
  });
});

describe('call log rows', () => {
  it('never carry the inputs or the outputs', async () => {
    const args = { load: 98765.4321, span: 12.3456, note: 'input-sentinel' };
    const outputs = { deflection: 55555.125, label: 'output-sentinel' };
    await dispatchFunctionCall(call({ args }), { runner: runnerOf(ok({ outputs, printed: 'printed-sentinel' })) });
    await dispatchFunctionCall(call({ args: { ...args, load: 'bad' } }), { runner: runnerOf(ok()) });
    expect(h.rows).toHaveLength(2);
    const text = JSON.stringify(h.rows);
    for (const leaked of ['98765.4321', '12.3456', 'input-sentinel', '55555.125', 'output-sentinel', 'printed']) {
      expect(text).not.toContain(leaked);
    }
    for (const row of h.rows) {
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['args', 'params', 'inputs', 'outputs']));
    }
  });
});

describe('the stamp', () => {
  it('sorts the packages by name and names the pin, the runtime, and the surface', () => {
    const stamp = buildCallableFunctionStamp({
      fn: record() as never,
      inputHash: functionInputHash(ARGS),
      run: ok({
        runtime: {
          lockHash: LOCK,
          packages: [
            { name: 'scipy', version: '1.11.4' },
            { name: 'numpy', version: '1.26.4' },
            { name: 'pandas', version: '1.5.3' },
          ],
        },
      }),
      surface: 'test',
      calledAt: new Date('2026-11-23T12:00:00.000Z'),
    });
    expect(stamp).toEqual({
      function_id: FUNCTION_ID,
      slug: CONTRACT.name,
      pin_version: 3,
      code_hash: HASH,
      input_hash: functionInputHash(ARGS),
      runtime: { kind: 'pyodide-server', version: '0.25.1', lock_hash: LOCK },
      packages: [
        { name: 'numpy', version: '1.26.4' },
        { name: 'pandas', version: '1.5.3' },
        { name: 'scipy', version: '1.11.4' },
      ],
      data: [],
      uses: [],
      surface: 'test',
      duration_ms: 40,
      called_at: '2026-11-23T12:00:00.000Z',
    });
  });

  it('hashes the inputs the same whatever their key order', () => {
    const a = { load: 1, span: 2, nested: { b: [1, 2], a: true } };
    const b = { nested: { a: true, b: [1, 2] }, span: 2, load: 1 };
    expect(functionInputHash(a)).toBe(functionInputHash(b));
    expect(functionInputHash(a)).toBe(createHash('sha256').update(canonicalJson(a)).digest('hex'));
    expect(functionInputHash({ ...a, load: 3 })).not.toBe(functionInputHash(a));
  });
});

describe('readServerContract', () => {
  it('reads FUNCTION through the runner with the short time limit', async () => {
    const runner = runnerOf({ outcome: 'ok', contract: CONTRACT, durationMs: 5 });
    await expect(readServerContract(SOURCE, runner)).resolves.toEqual({ ok: true, contract: CONTRACT });
    expect(runner).toHaveBeenCalledWith({ op: 'read_contract', code: SOURCE, limits: { timeoutMs: 10_000 } });
  });

  it('reports a read that timed out or found no contract', async () => {
    await expect(readServerContract(SOURCE, runnerOf({ outcome: 'timeout', durationMs: 10_000 }))).resolves.toEqual({
      ok: false,
      outcome: 'timeout',
    });
    await expect(
      readServerContract(SOURCE, runnerOf({ outcome: 'error', reason: 'contract_missing', durationMs: 5 }))
    ).resolves.toMatchObject({ ok: false, reason: 'contract_missing' });
    await expect(readServerContract(SOURCE, null)).resolves.toMatchObject({ ok: false, reason: 'runtime_unavailable' });
  });

  it('stops waiting at the hard deadline', async () => {
    vi.useFakeTimers();
    const pending = readServerContract(
      SOURCE,
      vi.fn(() => new Promise<never>(() => {}))
    );
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 + 15_000);
    await expect(pending).resolves.toMatchObject({ ok: false, outcome: 'error', reason: 'no_reply' });
  });
});
