import { describe, it, expect, vi } from 'vitest';
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import {
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
const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

describe('createLambdaCallableFunctionRunner', () => {
  it('invokes the configured function RequestResponse with the payload and returns the parsed result', async () => {
    const send = vi.fn(async (_command: InvokeCommand) => ({
      Payload: encode({ outcome: 'error', errorClass: 'ValueError', printed: 'x', durationMs: 12, extra: 'dropped' }),
    }));
    const result = await createLambdaCallableFunctionRunner('runtime-fn', send)(payload);
    expect(result).toEqual({ outcome: 'error', errorClass: 'ValueError', printed: 'x', durationMs: 12 });
    const input = send.mock.calls[0][0].input;
    expect(input.FunctionName).toBe('runtime-fn');
    expect(input.InvocationType).toBe('RequestResponse');
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
      await expect(createLambdaCallableFunctionRunner('runtime-fn', send)(payload)).rejects.toThrow(
        /^Callable function runtime invocation failed$/
      );
    }
  });
});

describe('parseCallableFunctionRunResult', () => {
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
