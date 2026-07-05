/**
 * Wraps the pyodideManager singleton to provide React-friendly state.
 * Supports interrupt capability for stopping infinite loops.
 */

import { useState, useEffect, useCallback } from 'react';
import { pyodideManager, PyodideManagerState } from '@client/app/utils/pyodideManager';
import type { ExecutionResult } from '@client/app/workers/pyodide/types';

export function usePyodide() {
  const [state, setState] = useState<PyodideManagerState>(pyodideManager.getState());

  useEffect(() => {
    return pyodideManager.subscribe(setState);
  }, []);

  const initialize = useCallback(async () => {
    await pyodideManager.initialize();
  }, []);

  const execute = useCallback(async (code: string, packages?: string[]): Promise<ExecutionResult> => {
    const detectedPackages = packages || pyodideManager.detectPackages(code);
    return await pyodideManager.execute(code, detectedPackages);
  }, []);

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
    streamingOutput: state.streamingOutput,

    // Methods
    initialize,
    execute,
    interrupt,
    detectPackages,
    isReady,
    getSupportedPackages,
  };
}
