import { Logger, type ILogger } from '@bike4mind/observability';
import {
  CALLABLE_FUNCTION_CHILD_PATH_ENV,
  CALLABLE_FUNCTION_PYODIDE_DIR_ENV,
  runCallableFunctionInChild,
  sweepCallableFunctionChildren,
  type CallableFunctionRunResult,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';

// Lambda entry for the callable function runtime. The child gets none of this process's environment;
// nothing here logs the payload, which carries the caller's code and inputs.

export { CALLABLE_FUNCTION_CHILD_PATH_ENV, CALLABLE_FUNCTION_PYODIDE_DIR_ENV };

export function createHandler(env: NodeJS.ProcessEnv = process.env, logger: ILogger = new Logger()) {
  return async (event: unknown): Promise<CallableFunctionRunResult> => {
    sweepCallableFunctionChildren();
    const childPath = env[CALLABLE_FUNCTION_CHILD_PATH_ENV];
    const pyodideDir = env[CALLABLE_FUNCTION_PYODIDE_DIR_ENV];
    if (!childPath || !pyodideDir) return { outcome: 'refused', reason: 'runtime_unavailable', durationMs: 0 };
    const started = Date.now();
    try {
      return await runCallableFunctionInChild(event, { childPath, pyodideDir });
    } catch (error) {
      logger.error('Callable function runtime failed', error);
      return { outcome: 'error', reason: 'runtime_unavailable', durationMs: Date.now() - started };
    } finally {
      sweepCallableFunctionChildren();
    }
  };
}

export const handler = createHandler();
