import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import {
  callableFunctionRuntimeConfigured,
  callableFunctionTenantId,
  createInProcessCallableFunctionRunner,
  createLambdaCallableFunctionRunner,
  parseCallableFunctionRunResult,
  selectCallableFunctionRunner,
} from './runtimeRunner';
import { runCallableFunctionInChild } from './runtimeParent';

const lambdaSend = vi.hoisted(() => vi.fn(async (_command: InvokeCommand) => ({})));
vi.mock('@aws-sdk/client-lambda', async importOriginal => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-lambda')>()),
  LambdaClient: class {
    send = lambdaSend;
  },
}));

vi.mock('./runtimeParent', async importOriginal => {
  const actual = await importOriginal<typeof import('./runtimeParent')>();
  return { ...actual, runCallableFunctionInChild: vi.fn() };
});

const payload = { op: 'read_contract' as const, code: 'FUNCTION = {}' };
const tenant = { callerUserId: 'user-1', codeHash: '3f2a9c' };
const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

describe('createLambdaCallableFunctionRunner', () => {
  it('invokes the configured function RequestResponse with the payload and returns the parsed result', async () => {
    const send = vi.fn(async (_command: InvokeCommand) => ({
      Payload: encode({
        outcome: 'error',
        errorClass: 'ValueError',
        printed: 'x',
        durationMs: 12,
        startMs: 7,
        extra: 'dropped',
      }),
    }));
    const result = await createLambdaCallableFunctionRunner('runtime-fn', send)(payload, tenant);
    expect(result).toEqual({ outcome: 'error', errorClass: 'ValueError', printed: 'x', durationMs: 12, startMs: 7 });
    const input = send.mock.calls[0][0].input;
    expect(input.FunctionName).toBe('runtime-fn');
    expect(input.InvocationType).toBe('RequestResponse');
    expect(input.TenantId).toBe(createHash('sha256').update('user-1:3f2a9c').digest('hex'));
    expect(JSON.parse(Buffer.from(input.Payload as Uint8Array).toString('utf8'))).toEqual(payload);
  });

  it('throws fixed text for a FunctionError, a send failure, a missing or unparsable payload, and an unknown outcome', async () => {
    const replies = [
      async () => ({ FunctionError: 'Unhandled', Payload: encode({ errorMessage: 'guest text' }) }),
      async () => {
        throw new Error('network said guest text');
      },
      async () => ({}),
      async () => ({ Payload: new TextEncoder().encode('not json') }),
      async () => ({ Payload: encode({ outcome: 'escaped', durationMs: 1 }) }),
      async () => ({ Payload: encode({ outcome: 'ok', reason: 'guest text', durationMs: 1 }) }),
    ];
    for (const send of replies) {
      await expect(createLambdaCallableFunctionRunner('runtime-fn', send)(payload, tenant)).rejects.toThrow(
        /^Callable function runtime invocation failed$/
      );
    }
  });
});

describe('callableFunctionTenantId', () => {
  it('is one id per caller and code hash', () => {
    const ids = [
      callableFunctionTenantId(tenant),
      callableFunctionTenantId({ ...tenant }),
      callableFunctionTenantId({ ...tenant, callerUserId: 'user-2' }),
      callableFunctionTenantId({ ...tenant, codeHash: '3f2a9d' }),
    ];
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('parseCallableFunctionRunResult', () => {
  it('keeps the outputs object and drops a stamp, which only the dispatcher fills', () => {
    expect(
      parseCallableFunctionRunResult({
        outcome: 'ok',
        durationMs: 1,
        outputs: { deflection: 0.004 },
        stamp: { codeHash: 'from the runtime' },
        value: { deflection: 1 },
      })
    ).toEqual({ outcome: 'ok', durationMs: 1, outputs: { deflection: 0.004 } });
  });

  it('drops problems that are not path and message pairs and refuses an invalid contract', () => {
    expect(
      parseCallableFunctionRunResult({
        outcome: 'output_invalid',
        durationMs: 1,
        problems: [{ path: 'a', message: 'is required' }, { path: 1 }],
      })
    ).toEqual({ outcome: 'output_invalid', durationMs: 1, problems: [{ path: 'a', message: 'is required' }] });
    expect(parseCallableFunctionRunResult({ outcome: 'ok', durationMs: 1, contract: { name: 'x' } })).toBeNull();
  });

  it('refuses a reply whose error class the call log would refuse', () => {
    const error = (errorClass: unknown) =>
      parseCallableFunctionRunResult({ outcome: 'error', durationMs: 1, errorClass });
    expect(error('ZeroDivisionError')).toEqual({ outcome: 'error', durationMs: 1, errorClass: 'ZeroDivisionError' });
    expect(error('v_input text with spaces')).toBeNull();
    expect(error(7)).toBeNull();
  });
});

describe('callableFunctionRuntimeConfigured', () => {
  it('is true with the function name or both child paths, false otherwise', () => {
    const configured = (env: Record<string, string>) => callableFunctionRuntimeConfigured(env as NodeJS.ProcessEnv);
    expect(configured({ CALLABLE_FUNCTION_RUNTIME_FUNCTION_NAME: 'runtime-fn' })).toBe(true);
    const both = { CALLABLE_FUNCTION_CHILD_PATH: '/srv/child.ts', CALLABLE_FUNCTION_PYODIDE_DIR: '/srv/pyodide' };
    expect(configured(both)).toBe(true);
    expect(configured({ CALLABLE_FUNCTION_CHILD_PATH: '/srv/child.ts' })).toBe(false);
    expect(configured({})).toBe(false);
  });

  const name = { CALLABLE_FUNCTION_RUNTIME_FUNCTION_NAME: 'runtime-fn' };
  const child = { CALLABLE_FUNCTION_CHILD_PATH: '/srv/child.ts' };
  const pyodide = { CALLABLE_FUNCTION_PYODIDE_DIR: '/srv/pyodide' };
  const emptyName = { CALLABLE_FUNCTION_RUNTIME_FUNCTION_NAME: '' };
  it.each([
    ['the function name', name],
    ['both child paths', { ...child, ...pyodide }],
    ['the child path only', child],
    ['the Pyodide directory only', pyodide],
    ['an empty function name and both child paths', { ...emptyName, ...child, ...pyodide }],
    ['nothing', {}],
  ])('agrees with selectCallableFunctionRunner given %s', (_label, env) => {
    const processEnv = env as NodeJS.ProcessEnv;
    expect(callableFunctionRuntimeConfigured(processEnv)).toBe(selectCallableFunctionRunner(processEnv) !== null);
  });
});

describe('the runtime report in a reply', () => {
  const lockHash = 'c'.repeat(64);

  it('keeps the lock hash and well-formed packages', () => {
    const runtime = { lockHash, packages: [{ name: 'numpy', version: '1.26.4' }, { name: '../x', version: '1' }, 7] };
    expect(parseCallableFunctionRunResult({ outcome: 'ok', durationMs: 1, runtime })).toEqual({
      outcome: 'ok',
      durationMs: 1,
      runtime: { lockHash, packages: [{ name: 'numpy', version: '1.26.4' }] },
    });
  });

  it('drops a report whose lock hash is not a sha256', () => {
    const runtime = { lockHash: 'guest text', packages: [] };
    expect(parseCallableFunctionRunResult({ outcome: 'ok', durationMs: 1, runtime })).toEqual({
      outcome: 'ok',
      durationMs: 1,
    });
  });
});

describe('selectCallableFunctionRunner', () => {
  it('picks the Lambda runner when the environment names the function', async () => {
    vi.mocked(runCallableFunctionInChild).mockClear();
    const runner = selectCallableFunctionRunner({
      CALLABLE_FUNCTION_RUNTIME_FUNCTION_NAME: 'runtime-fn',
      CALLABLE_FUNCTION_CHILD_PATH: '/srv/child.ts',
      CALLABLE_FUNCTION_PYODIDE_DIR: '/srv/pyodide',
    } as NodeJS.ProcessEnv);
    expect(runner).not.toBeNull();
    await expect(runner!(payload, tenant)).rejects.toThrow(/^Callable function runtime invocation failed$/);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    expect(lambdaSend.mock.calls[0][0].input.FunctionName).toBe('runtime-fn');
    expect(runCallableFunctionInChild).not.toHaveBeenCalled();
  });

  it('picks the in-process runner when only the child paths are set, and none when they are not', async () => {
    vi.mocked(runCallableFunctionInChild).mockResolvedValue({ outcome: 'ok', durationMs: 1 });
    const env = { CALLABLE_FUNCTION_CHILD_PATH: '/srv/child.ts', CALLABLE_FUNCTION_PYODIDE_DIR: '/srv/pyodide' };
    await selectCallableFunctionRunner(env as NodeJS.ProcessEnv)!(payload, tenant);
    expect(runCallableFunctionInChild).toHaveBeenCalledWith(payload, {
      childPath: '/srv/child.ts',
      pyodideDir: '/srv/pyodide',
    });
    expect(
      selectCallableFunctionRunner({ CALLABLE_FUNCTION_CHILD_PATH: '/srv/child.ts' } as NodeJS.ProcessEnv)
    ).toBeNull();
  });
});

describe('createInProcessCallableFunctionRunner', () => {
  it('runs the payload through a local child with the given paths', async () => {
    vi.mocked(runCallableFunctionInChild).mockResolvedValue({ outcome: 'timeout', durationMs: 30_000 });
    const options = { childPath: '/srv/child.ts', pyodideDir: '/srv/pyodide' };
    expect(await createInProcessCallableFunctionRunner(options)(payload)).toEqual({
      outcome: 'timeout',
      durationMs: 30_000,
    });
    expect(runCallableFunctionInChild).toHaveBeenCalledWith(payload, options);
  });
});
