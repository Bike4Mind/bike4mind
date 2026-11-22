import {
  runCallableFunctionInChild,
  sweepCallableFunctionChildren,
  type CallableFunctionRunResult,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';

// Lambda entry for the callable function runtime. The child gets none of this process's environment;
// nothing here logs the payload, which carries the caller's code and inputs.

/** Path of `child.ts` (or its build) in the image. */
export const CALLABLE_FUNCTION_CHILD_PATH_ENV = 'CALLABLE_FUNCTION_CHILD_PATH';
/** Directory holding pyodide.mjs, the rest of the Pyodide core, pyodide-lock.json and the package wheels. */
export const CALLABLE_FUNCTION_PYODIDE_DIR_ENV = 'CALLABLE_FUNCTION_PYODIDE_DIR';

export function createHandler(env: NodeJS.ProcessEnv = process.env) {
  return async (event: unknown): Promise<CallableFunctionRunResult> => {
    sweepCallableFunctionChildren();
    const childPath = env[CALLABLE_FUNCTION_CHILD_PATH_ENV];
    const pyodideDir = env[CALLABLE_FUNCTION_PYODIDE_DIR_ENV];
    if (!childPath || !pyodideDir) return { outcome: 'refused', reason: 'runtime_unavailable', durationMs: 0 };
    try {
      return await runCallableFunctionInChild(event, { childPath, pyodideDir });
    } finally {
      sweepCallableFunctionChildren();
    }
  };
}

export const handler = createHandler();
