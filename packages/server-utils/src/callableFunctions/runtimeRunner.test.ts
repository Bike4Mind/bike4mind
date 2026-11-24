import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import {
  callableFunctionTenantId,
  createInProcessCallableFunctionRunner,
  createLambdaCallableFunctionRunner,
  parseCallableFunctionRunResult,
} from './runtimeRunner';
import { runCallableFunctionInChild } from './runtimeParent';

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
