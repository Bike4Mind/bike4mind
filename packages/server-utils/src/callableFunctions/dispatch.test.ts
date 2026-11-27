// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PYODIDE_VERSION,
  canonicalJson,
  parseFunctionContract,
  reviewHash,
  type FunctionContract,
  type ICallableFunctionCall,
} from '@bike4mind/common';
import type { CallableFunctionRunPayload, CallableFunctionRunResult } from './runtimeParent';
import type { CallableFunctionTenant } from './runtimeRunner';

const h = vi.hoisted(() => ({
  enabled: true,
  fn: null as Record<string, unknown> | null,
  hostFn: null as Record<string, unknown> | null,
  artifact: null as Record<string, unknown> | null,
  rows: [] as Record<string, unknown>[],
  reads: [] as string[],
  /** How long each read takes under fake timers. */
  readMs: 0,
  review: null as { enabled: boolean; reviewHash: string } | null,
}));
const readTakesTime = vi.hoisted(() => () => {
  if (h.readMs > 0) vi.setSystemTime(Date.now() + h.readMs);
});

vi.mock('./access', () => ({
  resolveCallableFunctionsEnabled: vi.fn(async () => {
    h.reads.push('setting');
    readTakesTime();
    return h.enabled;
  }),
}));
vi.mock('@bike4mind/database', async () => ({
  mongoose: (await import('mongoose')).default,
  callableFunctionRepository: {
    findBySlugForOwner: vi.fn(async () => h.hostFn),
    findById: vi.fn(async () => {
      h.reads.push('record');
      readTakesTime();
      return h.fn;
    }),
  },
  callableFunctionReviewRepository: { findFor: vi.fn(async () => h.review) },
  artifactRepository: {
    findOne: vi.fn(async () => {
      h.reads.push('head');
      readTakesTime();
      return h.artifact;
    }),
  },
  callableFunctionCallRepository: {
    record: vi.fn(async (row: Record<string, unknown>, _callId?: string) => {
      h.rows.push(row);
      return { ...row, id: `call-${h.rows.length}` };
    }),
  },
}));

vi.mock('./registry', () => ({ listOfferedCallableFunctions: vi.fn(async () => []) }));
vi.mock('../mcpConnections/customMcpToolHost', () => ({
  customMcpToolHost: { listConnections: vi.fn(async () => []), callTool: vi.fn() },
}));

import { createFunctionToolHost, FUNCTION_CONNECTION_ID } from './functionToolHost';
import { artifactRepository, callableFunctionCallRepository, callableFunctionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { resolveCallableFunctionsEnabled } from './access';
import {
  CALLABLE_FUNCTION_SURFACE_CAPS,
  buildCallableFunctionStamp,
  dispatchFunctionCall,
  functionInputHash,
  readServerContract,
} from './dispatch';
import { CallableFunctionSourceError } from './fetchSource';

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
  vi.fn(async (_payload: CallableFunctionRunPayload, _tenant: CallableFunctionTenant) =>
    typeof result === 'function' ? result() : result
  );

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
  h.hostFn = record({ state: 'live', approval: 'default' });
  h.artifact = { id: 'artifact-1', version: 3, deletedAt: null };
  h.rows = [];
  h.reads = [];
  h.readMs = 0;
  h.review = null;
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

  it('refuses anyone but the owner before reading the status, and names the reason in the row only', async () => {
    const result = await dispatchFunctionCall(call({ caller: { id: 'stranger-1' } }), { runner: runnerOf(ok()) });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(h.reads).toEqual(['setting', 'record']);
    expect(onlyRow()).toMatchObject({
      reason: 'not_caller',
      ownerUserId: OWNER.id,
      callerUserId: 'stranger-1',
      codeHash: HASH,
    });
  });

  it("answers another owner's function exactly as a missing one", async () => {
    const stranger = { id: 'stranger-1' };
    const refusal = async () => {
      const result = await dispatchFunctionCall(call({ caller: stranger }), { runner: runnerOf(ok()) });
      const { callId: _callId, durationMs: _durationMs, ...rest } = result;
      return rest;
    };
    const theirs = await refusal();
    h.fn = null;
    const missing = await refusal();
    expect(theirs).toEqual(missing);
    expect(theirs).toEqual({ outcome: 'refused', reason: 'not_found' });
    expect(h.rows.map(row => row.reason)).toEqual(['not_caller', 'not_found']);
  });

  it('checks a recipient review against the contract the call runs under, not the record copy', async () => {
    h.fn = record({ state: 'live', grants: { visibility: 'private', userIds: ['person-1'] } });
    h.review = { enabled: true, reviewHash: await reviewHash(CONTRACT) };
    const read = { ...CONTRACT, description: 'Read from the pinned code, and changed.' };
    const runner = runnerOf(ok());

    const result = await dispatchFunctionCall(call({ caller: { id: 'person-1' } }), { runner, contract: read });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'review_required' });
    expect(runner).not.toHaveBeenCalled();

    await expect(dispatchFunctionCall(call({ caller: { id: 'person-1' } }), { runner })).resolves.toMatchObject({
      outcome: 'ok',
    });
  });

  it('refuses a turned-off function before checking the inputs', async () => {
    h.fn = record({ enabled: false });
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ args: { load: 'heavy' } }), { runner });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow()).toMatchObject({ outcome: 'refused', reason: 'disabled' });
  });

  it('refuses a function whose artifact was deleted', async () => {
    h.artifact = null;
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call(), { runner });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'source_deleted' });
    expect(h.reads).toEqual(['setting', 'record', 'head']);
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow()).toMatchObject({ outcome: 'refused', reason: 'source_deleted' });
  });

  it('measures the input size before validating, so an oversize input is never walked', async () => {
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ args: { load: 'heavy', samples: OVERSIZE } }), { runner });
    expect(result).toMatchObject({ outcome: 'input_invalid', reason: 'input_too_large' });
    expect(result.problems).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow()).toMatchObject({ outcome: 'input_invalid', reason: 'input_too_large' });
  });

  it('refuses inputs that break the contract', async () => {
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ args: { load: 'heavy' } }), { runner });
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
    h.fn = record({ state: 'live' });
    const runner = runnerOf(ok());
    const result = await dispatchFunctionCall(call({ surface: 'chat' }), { runner });
    expect(result).toMatchObject({ outcome: 'ok', outputs: { deflection: 8381.0 }, callId: 'call-1' });
    expect(runner).toHaveBeenCalledWith(
      {
        op: 'call',
        code: SOURCE,
        contract: CONTRACT,
        params: ARGS,
        limits: { timeoutMs: 30_000, outputBytes: 256 * 1024 },
      },
      { callerUserId: OWNER.id, codeHash: HASH }
    );
    expect(onlyRow()).toMatchObject({
      op: 'call',
      outcome: 'ok',
      surface: 'chat',
      inputHash: functionInputHash(ARGS),
      runtime: { kind: 'pyodide-server', version: '0.25.1', lockHash: LOCK },
      initMs: 900,
      durationMs: 40,
    });
  });

  it("hands the runner signed links for this function's pins only, never bytes, and stamps what it read", async () => {
    const pins = ['b.csv', 'a.csv'].map((name, i) => ({
      name,
      sha256: String(i).repeat(64),
      bytes: 8 + i,
      sourceFileId: `file-${i}`,
      pinnedAt: new Date(0),
    }));
    h.fn = record({ pin: { ...(record().pin as object), dataPins: pins } });
    const signData = vi.fn(async (fn: { id: string }) =>
      pins.map(({ name, sha256, bytes }) => ({
        name,
        sha256,
        bytes,
        url: `https://data.example.com/${fn.id}/${sha256}`,
      }))
    );
    const runner = runnerOf(ok());

    const result = await dispatchFunctionCall(call(), { runner, signData, dataReachable: true });

    expect(signData).toHaveBeenCalledWith(expect.objectContaining({ id: FUNCTION_ID }));
    const payload = runner.mock.calls[0]![0] as CallableFunctionRunPayload & { data?: { prefix: string }[] };
    expect(payload.data).toEqual(
      pins.map(({ name, sha256, bytes }) => ({
        name,
        sha256,
        bytes,
        prefix: FUNCTION_ID,
        url: `https://data.example.com/${FUNCTION_ID}/${sha256}`,
      }))
    );
    // The browser panel builds its stamp's list from the same pins in the same shape.
    const browserData = pins.map(({ name, sha256, bytes }) => ({ name, mode: 'pinned', sha256, bytes }));
    expect(result.stamp?.data).toEqual(browserData);
    expect(onlyRow().dataHashes).toEqual(pins.map(pin => pin.sha256));
  });

  describe('sources', () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const ORIGIN = 'https://data.example.com';
    let origin = 'a,b\n1,2\n';
    const fetcher = vi.fn(async () => ({
      body: Buffer.from(origin),
      sha256: sha(origin),
      bytes: Buffer.byteLength(origin),
      fetchedAt: new Date().toISOString(),
    }));
    const stored = new Map<string, Buffer>();
    const storage = {
      uploadStream: vi.fn(async (body: AsyncIterable<Buffer>, key: string) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk);
        stored.set(key, Buffer.concat(chunks));
        return key;
      }),
      getSignedUrl: vi.fn(async (key: string) => `${ORIGIN}/${key}?signed`),
    };
    const frozen = { name: 'pinned.csv', sha256: sha('frozen'), bytes: 6, fetchedAt: new Date(0) };
    const deps = () => ({
      fetcher,
      storage: storage as never,
      origins: [ORIGIN],
      limits: { fileBytes: 1024, totalBytes: 4096 },
    });
    const withSources = () => {
      fetcher.mockClear();
      h.fn = record({
        sources: [
          { name: 'live.csv', url: `${ORIGIN}/live.csv`, mode: 'live' },
          { name: 'pinned.csv', url: `${ORIGIN}/pinned.csv`, mode: 'pinned' },
        ],
        pin: { ...(record().pin as object), sourcePins: [frozen] },
      });
    };

    it('stamps a live source with its hash and fetch time and a pinned one with its frozen hash', async () => {
      withSources();
      origin = 'a,b\n1,2\n';
      const runner = runnerOf(ok());
      const result = await dispatchFunctionCall(call(), { runner, sources: deps(), dataReachable: true });

      expect(result.stamp?.data).toEqual([
        { name: 'live.csv', mode: 'live', sha256: sha(origin), bytes: 8, fetched_at: expect.any(String) },
        { name: 'pinned.csv', mode: 'pinned', sha256: frozen.sha256, bytes: 6 },
      ]);
      const payload = runner.mock.calls[0]![0] as CallableFunctionRunPayload & { data?: { url: string }[] };
      expect(payload.data?.map(entry => entry.url)).toEqual([
        `${ORIGIN}/data/.live/${FUNCTION_ID}/${sha(origin)}?signed`,
        `${ORIGIN}/data/${FUNCTION_ID}/${frozen.sha256}?signed`,
      ]);
      expect([...stored.keys()]).toEqual([`data/.live/${FUNCTION_ID}/${sha(origin)}`]);
      expect(stored.get(`data/.live/${FUNCTION_ID}/${sha(origin)}`)?.toString()).toBe(origin);
      expect(onlyRow().dataHashes).toEqual([sha(origin), frozen.sha256]);
    });

    it('gives a live source two hashes across a data change and keeps the pinned hash', async () => {
      withSources();
      origin = 'a,b\n1,2\n';
      const first = await dispatchFunctionCall(call(), {
        runner: runnerOf(ok()),
        sources: deps(),
        dataReachable: true,
      });
      origin = 'a,b\n1,3\n';
      const second = await dispatchFunctionCall(call(), {
        runner: runnerOf(ok()),
        sources: deps(),
        dataReachable: true,
      });

      const hashOf = (stamp: typeof first.stamp, name: string) => stamp?.data.find(e => e.name === name)?.sha256;
      expect(hashOf(first.stamp, 'live.csv')).toBe(sha('a,b\n1,2\n'));
      expect(hashOf(second.stamp, 'live.csv')).toBe(sha('a,b\n1,3\n'));
      expect(hashOf(second.stamp, 'pinned.csv')).toBe(hashOf(first.stamp, 'pinned.csv'));
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('counts the source fetch against the wait, so the run gets only what is left', async () => {
      withSources();
      vi.useFakeTimers();
      const slow = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 8_000));
        return fetcher();
      });
      const runner = vi.fn((_payload: CallableFunctionRunPayload) => new Promise<never>(() => {}));
      const pending = dispatchFunctionCall(call(), {
        runner,
        waitMs: 20_000,
        timeoutMs: 600_000,
        sources: { ...deps(), fetcher: slow },
        dataReachable: true,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runner.mock.calls[0][0]).toMatchObject({ limits: { timeoutMs: 12_000 } });
      await expect(pending).resolves.toMatchObject({ outcome: 'timeout', reason: 'wait_exceeded' });
    });

    it("charges the source fetch to the call's own time limit and ends a stall there as a timeout", async () => {
      withSources();
      vi.useFakeTimers();
      const stalled = vi.fn(async (request: { timeoutMs: number }) => {
        await new Promise(resolve => setTimeout(resolve, request.timeoutMs));
        throw new CallableFunctionSourceError('source_timeout', 'stalled');
      });
      const runner = runnerOf(ok());
      const pending = dispatchFunctionCall(call(), {
        runner,
        waitMs: 20_000,
        timeoutMs: 5_000,
        sources: { ...deps(), fetcher: stalled },
        dataReachable: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ outcome: 'timeout' });
      expect(stalled).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }));
      expect(runner).not.toHaveBeenCalled();
      expect(onlyRow()).toMatchObject({ outcome: 'timeout' });
    });

    it("ends a stall that outlasts the caller's wait as wait_exceeded, and one at the fetch's own ceiling as an error", async () => {
      withSources();
      vi.useFakeTimers();
      const stalled = vi.fn(async (request: { timeoutMs: number }) => {
        await new Promise(resolve => setTimeout(resolve, request.timeoutMs));
        throw new CallableFunctionSourceError('source_timeout', 'stalled');
      });
      const runner = runnerOf(ok());
      const short = dispatchFunctionCall(call(), {
        runner,
        waitMs: 4_000,
        sources: { ...deps(), fetcher: stalled },
        dataReachable: true,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(short).resolves.toMatchObject({ outcome: 'timeout', reason: 'wait_exceeded' });
      expect(stalled).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 4_000 }));

      const ceiling = dispatchFunctionCall(call(), {
        runner,
        waitMs: 40_000,
        sources: { ...deps(), fetcher: stalled },
        dataReachable: true,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(ceiling).resolves.toMatchObject({
        outcome: 'error',
        reason: 'source_unavailable',
        errorClass: 'source_timeout',
      });
      expect(runner).not.toHaveBeenCalled();
    });

    it('refuses a call with sources where this process was not given the data bucket, before fetching', async () => {
      withSources();
      const runner = runnerOf(ok());
      const result = await dispatchFunctionCall(call(), { runner, sources: deps(), dataReachable: false });
      expect(result).toMatchObject({ outcome: 'error', reason: 'data_unavailable' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
    });

    it('answers source_unavailable without running when a source is refused', async () => {
      withSources();
      const runner = runnerOf(ok());
      const refusing = vi.fn(async () => {
        throw new CallableFunctionSourceError('source_redirect_blocked', 'refused');
      });
      const result = await dispatchFunctionCall(call(), {
        runner,
        sources: { ...deps(), fetcher: refusing },
        dataReachable: true,
      });

      expect(result).toMatchObject({ outcome: 'error', reason: 'source_unavailable' });
      expect(runner).not.toHaveBeenCalled();
      expect(onlyRow()).toMatchObject({ reason: 'source_unavailable', errorClass: 'source_redirect_blocked' });
    });
  });

  it('answers data_unavailable without running when the links cannot be signed', async () => {
    h.fn = record({
      pin: {
        ...(record().pin as object),
        dataPins: [{ name: 'a.csv', sha256: 'a'.repeat(64), bytes: 1, sourceFileId: 'f', pinnedAt: new Date(0) }],
      },
    });
    const runner = runnerOf(ok());
    const signData = vi.fn(async () => {
      throw new Error('no credentials');
    });
    const result = await dispatchFunctionCall(call(), { runner, signData, dataReachable: true });
    expect(result).toMatchObject({ outcome: 'error', reason: 'data_unavailable' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses a data-pinned call where this process was not given the data bucket, before signing anything', async () => {
    h.fn = record({
      pin: {
        ...(record().pin as object),
        dataPins: [{ name: 'a.csv', sha256: 'a'.repeat(64), bytes: 1, sourceFileId: 'f', pinnedAt: new Date(0) }],
      },
    });
    const runner = runnerOf(ok());
    const signData = vi.fn(async () => []);
    const result = await dispatchFunctionCall(call(), { runner, signData, dataReachable: false });
    expect(result).toMatchObject({ outcome: 'error', reason: 'data_unavailable' });
    expect(signData).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
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
    h.fn = record({ state: 'live' });
    const big = ok({ outputs: { deflection: 1, samples: new Array(30_000).fill(0.123456789) } });
    const result = await dispatchFunctionCall(call({ surface: 'chat' }), { runner: runnerOf(big) });
    expect(result).toMatchObject({ outcome: 'output_too_large', reason: 'result_too_large' });
    expect(result.outputs).toBeUndefined();
  });

  it('records an error when the runner throws, and logs its cause without the call', async () => {
    const logged = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const result = await dispatchFunctionCall(call(), {
      runner: vi.fn(async () => {
        throw new Error('Callable function runtime invocation failed', { cause: 'AccessDeniedException' });
      }),
    });
    expect(result).toMatchObject({ outcome: 'error', reason: 'runtime_unavailable' });
    expect(onlyRow()).toMatchObject({ outcome: 'error', reason: 'runtime_unavailable' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('[CALLABLE_FUNCTION_RUNNER_FAILED]', {
      name: 'Error',
      message: 'Callable function runtime invocation failed',
      cause: 'AccessDeniedException',
    });
    const line = JSON.stringify(logged.mock.calls);
    for (const leaked of [SOURCE, String(ARGS.load), String(ARGS.span)]) expect(line).not.toContain(leaked);
    logged.mockRestore();
  });

  it('counts its own reads against the deadline, so the run waits only what is left after them', async () => {
    vi.useFakeTimers();
    h.readMs = 1_000;
    const runner = vi.fn((_payload: CallableFunctionRunPayload) => new Promise<never>(() => {}));
    let settled = false;
    const pending = dispatchFunctionCall(call(), { runner, deadline: Date.now() + 20_000, minWaitMs: 5_000 }).finally(
      () => {
        settled = true;
      }
    );
    await vi.advanceTimersByTimeAsync(17_000 - 1);
    expect(settled).toBe(false);
    expect(runner.mock.calls[0][0]).toMatchObject({ limits: { timeoutMs: 17_000 } });
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout', reason: 'wait_exceeded' });
  });

  it('refuses without running when its reads leave less than the minimum wait, and writes the row', async () => {
    vi.useFakeTimers();
    h.readMs = 1_000;
    const runner = vi.fn();
    const result = await dispatchFunctionCall(call(), { runner, deadline: Date.now() + 7_000, minWaitMs: 5_000 });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'budget_exhausted' });
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow()).toMatchObject({ outcome: 'refused', reason: 'budget_exhausted' });
  });

  it("stops waiting at the surface's cap when the runner never answers, and writes the row", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = dispatchFunctionCall(call(), { runner: vi.fn(() => new Promise<never>(() => {})) }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(45_000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout', reason: 'wait_exceeded' });
    expect(onlyRow()).toMatchObject({ outcome: 'timeout', reason: 'wait_exceeded' });
  });

  it("waits no longer than the caller's budget, and gives the guest no more time than the wait", async () => {
    vi.useFakeTimers();
    const runner = vi.fn((_payload: CallableFunctionRunPayload) => new Promise<never>(() => {}));
    let settled = false;
    const pending = dispatchFunctionCall(call(), { runner, waitMs: 7_000 }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(7_000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout', reason: 'wait_exceeded' });
    expect(runner.mock.calls[0][0]).toMatchObject({ limits: { timeoutMs: 7_000 } });
  });

  it("never waits past the surface's cap whatever the caller asks", async () => {
    vi.useFakeTimers();
    const runner = vi.fn((_payload: CallableFunctionRunPayload) => new Promise<never>(() => {}));
    const pending = dispatchFunctionCall(call(), { runner, waitMs: 600_000, timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout', reason: 'wait_exceeded' });
    expect(runner.mock.calls[0][0]).toMatchObject({ limits: { timeoutMs: 45_000 } });
  });
});

describe('one row on every path', () => {
  const thrown = new Error('database unavailable');

  it('retries an ambiguous write with one call id without running the guest twice', async () => {
    const runner = runnerOf(ok());
    const record = vi.mocked(callableFunctionCallRepository.record);
    record.mockImplementationOnce(async (row, callId) => {
      h.rows.push({ ...row, id: callId });
      throw thrown;
    });
    record.mockImplementationOnce(async (_row, callId) => ({ ...h.rows[0], id: callId }) as never);
    const result = await dispatchFunctionCall(call(), { runner });
    const attempts = record.mock.calls.slice(-2);
    expect(attempts[0][1]).toMatch(/^[0-9a-f]{24}$/);
    expect(attempts[1][1]).toBe(attempts[0][1]);
    expect(result.callId).toBe(attempts[0][1]);
    expect(h.rows).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1]).toEqual({ callerUserId: OWNER.id, codeHash: HASH });
  });

  it.each([
    ['the setting check', () => vi.mocked(resolveCallableFunctionsEnabled).mockRejectedValueOnce(thrown)],
    ['the record read', () => vi.mocked(callableFunctionRepository.findById).mockRejectedValueOnce(thrown)],
    ['the artifact read', () => vi.mocked(artifactRepository.findOne).mockRejectedValueOnce(thrown)],
  ])('writes one error row when %s throws, then rethrows', async (_step, fail) => {
    fail();
    const runner = runnerOf(ok());
    await expect(dispatchFunctionCall(call(), { runner })).rejects.toBe(thrown);
    expect(runner).not.toHaveBeenCalled();
    expect(onlyRow()).toMatchObject({
      op: 'call',
      outcome: 'error',
      reason: 'dispatch_failed',
      callerUserId: OWNER.id,
    });
  });

  it('tries a failed row write once more and answers with the second', async () => {
    vi.mocked(callableFunctionCallRepository.record).mockRejectedValueOnce(thrown);
    const result = await dispatchFunctionCall(call(), { runner: runnerOf(ok()) });
    expect(result).toMatchObject({ outcome: 'ok', callId: 'call-1' });
    const writes = vi.mocked(callableFunctionCallRepository.record).mock.calls.slice(-2);
    expect(writes.map(([row]) => row.outcome)).toEqual(['ok', 'ok']);
    expect(onlyRow()).toMatchObject({ outcome: 'ok' });
  });

  it('rethrows when the retried row write fails too, without a third write', async () => {
    const record = vi.mocked(callableFunctionCallRepository.record);
    const before = record.mock.calls.length;
    record.mockRejectedValueOnce(thrown).mockRejectedValueOnce(new Error('still unavailable'));
    await expect(dispatchFunctionCall(call(), { runner: runnerOf(ok()) })).rejects.toThrow('still unavailable');
    expect(record.mock.calls.length - before).toBe(2);
    expect(h.rows).toEqual([]);
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
      pin_seq: null,
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
      trust_label: null,
      surface: 'test',
      duration_ms: 40,
      called_at: '2026-11-23T12:00:00.000Z',
    });
  });

  it('names the promotion sequence and the label of a live function', () => {
    const live = record({
      state: 'live',
      trustLabel: 'verified',
      pin: { artifactId: 'artifact-1', version: 3, seq: 2, contentHash: HASH, source: SOURCE, pinnedAt: new Date() },
    });
    const stamp = buildCallableFunctionStamp({
      fn: live as never,
      inputHash: functionInputHash(ARGS),
      run: ok(),
      surface: 'test',
      calledAt: new Date('2026-11-23T12:00:00.000Z'),
    });
    expect(stamp).toMatchObject({ pin_version: 3, pin_seq: 2, trust_label: 'verified' });
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
  const read = (runner: Parameters<typeof readServerContract>[1]['runner'], waitMs?: number) =>
    readServerContract({ caller: OWNER, fn: record() as never, surface: 'test' }, { runner, waitMs });

  it('reads FUNCTION through the runner with the short time limit and logs the read as its own op', async () => {
    const packages = [{ name: 'numpy', version: '1.26.4' }];
    const runner = runnerOf({
      outcome: 'ok',
      contract: CONTRACT,
      durationMs: 5,
      initMs: 700,
      runtime: { lockHash: LOCK, packages },
    });
    await expect(read(runner)).resolves.toEqual({
      ok: true,
      contract: CONTRACT,
      callId: 'call-1',
      runtime: { kind: 'pyodide-server', version: PYODIDE_VERSION, lockHash: LOCK, packages },
    });
    expect(runner).toHaveBeenCalledWith(
      { op: 'read_contract', code: SOURCE, limits: { timeoutMs: 10_000 } },
      { callerUserId: OWNER.id, codeHash: HASH }
    );

    const row = onlyRow();
    expect(row).toMatchObject({
      op: 'read_contract',
      functionId: FUNCTION_ID,
      ownerUserId: OWNER.id,
      callerUserId: OWNER.id,
      surface: 'test',
      codeHash: HASH,
      outcome: 'ok',
      durationMs: 5,
      initMs: 700,
    });
    expect(row).not.toHaveProperty('inputHash');
    expect(row).not.toHaveProperty('inputBytes');
    expect(row).not.toHaveProperty('outputBytes');
  });

  it('reports and logs a read that timed out or found no contract', async () => {
    await expect(read(runnerOf({ outcome: 'timeout', durationMs: 10_000 }))).resolves.toEqual({
      ok: false,
      outcome: 'timeout',
      callId: 'call-1',
    });
    await expect(
      read(runnerOf({ outcome: 'error', reason: 'contract_missing', durationMs: 5 }))
    ).resolves.toMatchObject({ ok: false, reason: 'contract_missing' });
    expect(h.rows.map(row => [row.op, row.outcome, row.reason])).toEqual([
      ['read_contract', 'timeout', undefined],
      ['read_contract', 'error', 'contract_missing'],
    ]);
  });

  it('stops waiting at its share of the budget, so a cold runtime reads as wait_exceeded', async () => {
    vi.useFakeTimers();
    const pending = read(vi.fn(() => new Promise<never>(() => {})));
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ ok: false, outcome: 'timeout', reason: 'wait_exceeded' });
    expect(onlyRow()).toMatchObject({ op: 'read_contract', outcome: 'timeout', reason: 'wait_exceeded' });
  });

  it('waits no longer than what is left, and gives the read no more time than the wait', async () => {
    vi.useFakeTimers();
    const runner = vi.fn((_payload: CallableFunctionRunPayload) => new Promise<never>(() => {}));
    const pending = read(runner, 4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'wait_exceeded' });
    expect(runner.mock.calls[0][0]).toMatchObject({ limits: { timeoutMs: 4_000 } });
  });

  it('tries a failed row write once more, then rethrows', async () => {
    vi.mocked(callableFunctionCallRepository.record)
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('still unavailable'));
    await expect(read(runnerOf({ outcome: 'ok', contract: CONTRACT, durationMs: 5 }))).rejects.toThrow(
      'still unavailable'
    );
    expect(h.rows).toEqual([]);
  });
});

describe('surface caps', () => {
  it('never wait past 45 s, inside the web function', () => {
    for (const caps of Object.values(CALLABLE_FUNCTION_SURFACE_CAPS)) expect(caps.waitMs).toBeLessThanOrEqual(45_000);
  });
});

describe('function host and dispatch admission use the executing record', () => {
  it.each(['chat', 'agent'] as const)(
    'refuses a repinned draft at %s dispatch after the host read live',
    async surface => {
      h.fn = record({
        state: 'draft',
        pin: { ...record().pin, version: 4, source: 'new draft', contentHash: 'new-hash' },
      });
      const runner = runnerOf(ok());
      const host = createFunctionToolHost(surface, {
        dispatch: (request, options) => dispatchFunctionCall(request, { ...options, runner }),
      });
      const response = await host.callTool({
        connectionId: FUNCTION_CONNECTION_ID,
        userId: OWNER.id,
        toolName: CONTRACT.name,
        args: ARGS,
        approved: true,
      });
      expect(runner).not.toHaveBeenCalled();
      expect(response.result.content).toEqual([
        { type: 'text', text: JSON.stringify({ outcome: 'refused', reason: 'not_live' }) },
      ]);
      expect(onlyRow()).toMatchObject({ codeHash: 'new-hash', reason: 'not_live' });
    }
  );

  it.each(['chat', 'agent'] as const)('rechecks a new always-ask policy at %s dispatch', async surface => {
    h.fn = record({ state: 'live', approval: 'always_ask' });
    const runner = runnerOf(ok());
    const host = createFunctionToolHost(surface, {
      dispatch: (request, options) => dispatchFunctionCall(request, { ...options, runner }),
    });
    const response = await host.callTool({
      connectionId: FUNCTION_CONNECTION_ID,
      userId: OWNER.id,
      toolName: CONTRACT.name,
      args: ARGS,
      approved: false,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(response.result.content).toEqual([
      { type: 'text', text: JSON.stringify({ outcome: 'refused', reason: 'approval_required' }) },
    ]);
    expect(onlyRow()).toMatchObject({ reason: 'approval_required' });
  });

  it.each(['chat', 'agent'] as const)('forwards an explicit approval to an always-ask %s dispatch', async surface => {
    h.fn = record({ state: 'live', approval: 'always_ask' });
    const runner = runnerOf(ok());
    const host = createFunctionToolHost(surface, {
      dispatch: (request, options) => dispatchFunctionCall(request, { ...options, runner }),
    });
    const response = await host.callTool({
      connectionId: FUNCTION_CONNECTION_ID,
      userId: OWNER.id,
      toolName: CONTRACT.name,
      args: ARGS,
      approved: true,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(response.result.isError).toBeUndefined();
    expect(onlyRow()).toMatchObject({ outcome: 'ok' });
  });

  it.each(['test', 'rest'] as const)('retains explicit draft execution on the %s surface', async surface => {
    h.fn = record({ state: 'draft', approval: 'always_ask' });
    const runner = runnerOf(ok());
    expect(await dispatchFunctionCall(call({ surface }), { runner })).toMatchObject({ outcome: 'ok' });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
