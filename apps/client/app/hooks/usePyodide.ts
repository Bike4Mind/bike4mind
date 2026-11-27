/**
 * Wraps the pyodideManager singleton to provide React-friendly state.
 * Supports interrupt capability for stopping infinite loops.
 *
 * `owner` identifies whose code runs (the artifact id): code from a different owner never reuses the sandbox
 * another owner's code ran in.
 */

import { useState, useEffect, useCallback } from 'react';
import { pyodideManager, PyodideManagerState, type PythonFunctionCall } from '@client/app/utils/pyodideManager';
import { usePublicConfig } from '@client/app/hooks/data/settings';
import type { ExecutionResult } from '@client/app/workers/pyodide/types';

export function usePyodide(owner: string) {
  const [state, setState] = useState<PyodideManagerState>(pyodideManager.getState());

  // usePublicConfig (not useConfig) avoids the auth-timing race: the Pyodide mirror is a
  // public, pre-login setting, and configure() must land before the consumer calls initialize().
  const { data: publicConfig } = usePublicConfig();
  useEffect(() => {
    pyodideManager.configure(publicConfig?.pyodideBaseUrl || undefined);
  }, [publicConfig?.pyodideBaseUrl]);

  useEffect(() => {
    return pyodideManager.subscribe(setState);
  }, []);

  const initialize = useCallback(async () => {
    await pyodideManager.initialize(owner);
  }, [owner]);

  const execute = useCallback(
    async (code: string, packages?: string[]): Promise<ExecutionResult> => {
      const detectedPackages = packages || pyodideManager.detectPackages(code);
      return await pyodideManager.execute(owner, code, detectedPackages);
    },
    [owner]
  );

  const callFunction = useCallback(
    async (
      code: string,
      params: Record<string, unknown> | null,
      packages?: string[],
      files?: { name: string; bytes: ArrayBuffer }[]
    ): Promise<PythonFunctionCall> => {
      const detectedPackages = packages || pyodideManager.detectPackages(code);
      return await pyodideManager.callFunction(owner, code, detectedPackages, params, undefined, files);
    },
    [owner]
  );

  const interrupt = useCallback(() => {
    pyodideManager.interrupt();
  }, []);

  const detectPackages = useCallback((code: string): string[] => {
    return pyodideManager.detectPackages(code);
  }, []);

  const isReady = useCallback((): boolean => {
    return pyodideManager.isReady();
  }, []);

  const getSupportedPackages = useCallback((): string[] => {
    return pyodideManager.getSupportedPackages();
  }, []);

  return {
    // State
    isLoading: state.isLoading,
    loadProgress: state.loadProgress,
    loadedPackages: state.loadedPackages,
    error: state.error,
    isExecuting: state.isExecuting,
    executionStatus: state.executionStatus,
    streamingOutput: state.streamingOutput,

    // Methods
    initialize,
    execute,
    callFunction,
    interrupt,
    detectPackages,
    isReady,
    getSupportedPackages,
  };
}
