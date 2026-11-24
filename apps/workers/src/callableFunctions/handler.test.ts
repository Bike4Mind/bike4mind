import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runCallableFunctionInChild,
  sweepCallableFunctionChildren,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';
import { CALLABLE_FUNCTION_CHILD_PATH_ENV, CALLABLE_FUNCTION_PYODIDE_DIR_ENV, createHandler } from './handler';

vi.mock('@bike4mind/server-utils/callableFunctions/runtimeParent', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/callableFunctions/runtimeParent')>()),
  runCallableFunctionInChild: vi.fn(),
  sweepCallableFunctionChildren: vi.fn(() => 0),
}));

const event = { op: 'read_contract', code: 'FUNCTION = {}' };
const env = {
  [CALLABLE_FUNCTION_CHILD_PATH_ENV]: '/srv/child.ts',
  [CALLABLE_FUNCTION_PYODIDE_DIR_ENV]: '/srv/pyodide',
};

beforeEach(() => {
  vi.mocked(runCallableFunctionInChild).mockReset();
  vi.mocked(sweepCallableFunctionChildren).mockClear();
});

describe('callable function runtime handler', () => {
  it('runs the event in a child at the configured paths and sweeps before and after', async () => {
    vi.mocked(runCallableFunctionInChild).mockResolvedValue({ outcome: 'ok', durationMs: 3 });
    expect(await createHandler(env)(event)).toEqual({ outcome: 'ok', durationMs: 3 });
    expect(runCallableFunctionInChild).toHaveBeenCalledWith(event, {
      childPath: '/srv/child.ts',
      pyodideDir: '/srv/pyodide',
    });
    expect(sweepCallableFunctionChildren).toHaveBeenCalledTimes(2);
  });

  it('returns a closed runtime_unavailable error after the sweep when the run throws, logging the cause only', async () => {
    const cause = new Error('spawn failed');
    vi.mocked(runCallableFunctionInChild).mockRejectedValue(cause);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await createHandler(env, logger)(event);
    expect(result).toEqual({ outcome: 'error', reason: 'runtime_unavailable', durationMs: expect.any(Number) });
    expect(sweepCallableFunctionChildren).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), cause);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(event.code);
  });

  it('refuses as unavailable when the image paths are not configured', async () => {
    expect(await createHandler({})(event)).toEqual({
      outcome: 'refused',
      reason: 'runtime_unavailable',
      durationMs: 0,
    });
    expect(runCallableFunctionInChild).not.toHaveBeenCalled();
  });
});
