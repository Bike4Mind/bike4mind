import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@client/app/utils/pyodideManager', () => {
  const mockState = {
    isLoading: false,
    loadProgress: 0,
    loadedPackages: new Set<string>(),
    error: null,
    isReady: false,
    isExecuting: false,
  };

  const listeners = new Set<(state: typeof mockState) => void>();

  return {
    pyodideManager: {
      getState: vi.fn(() => ({ ...mockState })),
      subscribe: vi.fn((listener: (state: typeof mockState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      configure: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'test output',
        plots: [],
        executionTime: 100,
      }),
      interrupt: vi.fn(),
      detectPackages: vi.fn((code: string) => {
        const packages: string[] = [];
        if (code.includes('numpy')) packages.push('numpy');
        if (code.includes('pandas')) packages.push('pandas');
        return packages;
      }),
      isReady: vi.fn(() => false),
      getSupportedPackages: vi.fn(() => ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'scikit-learn']),
      // Helper for tests to simulate state changes
      _triggerStateChange: (newState: Partial<typeof mockState>) => {
        Object.assign(mockState, newState);
        listeners.forEach(l => l({ ...mockState }));
      },
    },
    PyodideManagerState: {},
  };
});

vi.mock('@client/app/workers/pyodide/types', () => ({
  ExecutionResult: {},
}));

// usePyodide reads the public config to pick up an optional Pyodide mirror; stub it so the
// hook renders without a react-query provider.
vi.mock('@client/app/hooks/data/settings', () => ({
  usePublicConfig: () => ({ data: undefined }),
}));

describe('usePyodide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return initial state', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadProgress).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.isExecuting).toBe(false);
  });

  it('should provide initialize function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    expect(typeof result.current.initialize).toBe('function');
  });

  it('should call pyodideManager.initialize when initialize is called', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    await act(async () => {
      await result.current.initialize();
    });

    expect(pyodideManager.initialize).toHaveBeenCalled();
  });

  it('should provide execute function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    expect(typeof result.current.execute).toBe('function');
  });

  it('should provide interrupt function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    expect(typeof result.current.interrupt).toBe('function');
  });

  it('should call pyodideManager.interrupt when interrupt is called', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    act(() => {
      result.current.interrupt();
    });

    expect(pyodideManager.interrupt).toHaveBeenCalled();
  });

  it('should return execution result', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    const expectedResult = {
      success: true,
      output: 'Hello, World!',
      plots: ['base64plot'],
      executionTime: 150,
    };

    vi.mocked(pyodideManager.execute).mockResolvedValue(expectedResult);

    const { result } = renderHook(() => usePyodide());

    let executionResult: typeof expectedResult | undefined;

    await act(async () => {
      executionResult = await result.current.execute('print("Hello, World!")');
    });

    expect(executionResult).toEqual(expectedResult);
  });

  it('should detect packages from code', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    const packages = result.current.detectPackages('import numpy as np\nimport pandas as pd');

    expect(packages).toContain('numpy');
    expect(packages).toContain('pandas');
  });

  it('should provide isReady function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    expect(typeof result.current.isReady).toBe('function');
    expect(result.current.isReady()).toBe(false);
  });

  it('should provide getSupportedPackages function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    const packages = result.current.getSupportedPackages();

    expect(packages).toContain('numpy');
    expect(packages).toContain('pandas');
    expect(packages).toContain('matplotlib');
  });

  it('should auto-detect packages if not provided', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    const { result } = renderHook(() => usePyodide());

    await act(async () => {
      await result.current.execute('import numpy as np');
    });

    // detectPackages should have been called
    expect(pyodideManager.detectPackages).toHaveBeenCalledWith('import numpy as np');

    // execute should have been called with detected packages
    expect(pyodideManager.execute).toHaveBeenCalledWith('import numpy as np', ['numpy']);
  });

  it('should use provided packages if specified', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    const { result } = renderHook(() => usePyodide());

    await act(async () => {
      await result.current.execute('x = 1', ['scipy']);
    });

    // execute should have been called with provided packages
    expect(pyodideManager.execute).toHaveBeenCalledWith('x = 1', ['scipy']);
  });

  it('should subscribe to state changes on mount', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    renderHook(() => usePyodide());

    expect(pyodideManager.subscribe).toHaveBeenCalled();
  });

  it('should unsubscribe on unmount', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    const unsubscribeMock = vi.fn();
    vi.mocked(pyodideManager.subscribe).mockReturnValue(unsubscribeMock);

    const { unmount } = renderHook(() => usePyodide());

    unmount();

    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it('should expose loadedPackages from state', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    expect(result.current.loadedPackages).toBeInstanceOf(Set);
  });

  it('should expose isExecuting from state', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide());

    expect(typeof result.current.isExecuting).toBe('boolean');
    expect(result.current.isExecuting).toBe(false);
  });
});
