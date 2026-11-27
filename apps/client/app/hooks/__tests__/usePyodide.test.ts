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
      callFunction: vi.fn().mockResolvedValue({ success: true, output: '', executionTime: 1 }),
      interrupt: vi.fn(),
      detectPackages: vi.fn((code: string) => {
        const packages: string[] = [];
        if (code.includes('numpy')) packages.push('numpy');
        if (code.includes('pandas')) packages.push('pandas');
        return packages;
      }),
      isReady: vi.fn(() => false),
      getSupportedPackages: vi.fn(() => ['numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn']),
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

// usePyodide reads the public config to pick up an optional Pyodide mirror; stub it (via a
// hoisted, mutable holder) so the hook renders without a react-query provider and tests can
// vary what the config returns.
const { publicConfigRef } = vi.hoisted(() => ({
  publicConfigRef: { current: undefined as { pyodideBaseUrl?: string } | undefined },
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  usePublicConfig: () => ({ data: publicConfigRef.current }),
}));

describe('usePyodide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicConfigRef.current = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('configures the pyodide manager with the public pyodideBaseUrl when config arrives', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    publicConfigRef.current = { pyodideBaseUrl: 'http://mirror.local/pyodide/' };
    const { usePyodide } = await import('../usePyodide');
    renderHook(() => usePyodide('artifact-a'));
    expect(pyodideManager.configure).toHaveBeenCalledWith('http://mirror.local/pyodide/');
  });

  it('should return initial state', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadProgress).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.isExecuting).toBe(false);
  });

  it('should provide initialize function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    expect(typeof result.current.initialize).toBe('function');
  });

  it('should call pyodideManager.initialize when initialize is called', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    await act(async () => {
      await result.current.initialize();
    });

    expect(pyodideManager.initialize).toHaveBeenCalled();
  });

  it('should provide execute function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    expect(typeof result.current.execute).toBe('function');
  });

  it('should provide interrupt function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    expect(typeof result.current.interrupt).toBe('function');
  });

  it('should call pyodideManager.interrupt when interrupt is called', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

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

    const { result } = renderHook(() => usePyodide('artifact-a'));

    let executionResult: typeof expectedResult | undefined;

    await act(async () => {
      executionResult = await result.current.execute('print("Hello, World!")');
    });

    expect(executionResult).toEqual(expectedResult);
  });

  it('runs and calls as its owner, and as the new owner once the artifact changes', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');
    const { result, rerender } = renderHook(({ owner }) => usePyodide(owner), {
      initialProps: { owner: 'artifact-a' },
    });

    await act(async () => {
      await result.current.initialize();
      await result.current.execute('print(1)', []);
      await result.current.callFunction('code', { n: 1 }, []);
    });
    expect(pyodideManager.initialize).toHaveBeenLastCalledWith('artifact-a');
    expect(pyodideManager.execute).toHaveBeenLastCalledWith('artifact-a', 'print(1)', []);
    expect(pyodideManager.callFunction).toHaveBeenLastCalledWith(
      'artifact-a',
      'code',
      [],
      { n: 1 },
      undefined,
      undefined
    );

    rerender({ owner: 'artifact-b' });
    await act(async () => {
      await result.current.initialize();
      await result.current.execute('print(2)', []);
      await result.current.callFunction('code', null, []);
    });
    expect(pyodideManager.initialize).toHaveBeenLastCalledWith('artifact-b');
    expect(pyodideManager.execute).toHaveBeenLastCalledWith('artifact-b', 'print(2)', []);
    expect(pyodideManager.callFunction).toHaveBeenLastCalledWith('artifact-b', 'code', [], null, undefined, undefined);
  });

  it('should detect packages from code', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    const packages = result.current.detectPackages('import numpy as np\nimport pandas as pd');

    expect(packages).toContain('numpy');
    expect(packages).toContain('pandas');
  });

  it('should provide isReady function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    expect(typeof result.current.isReady).toBe('function');
    expect(result.current.isReady()).toBe(false);
  });

  it('should provide getSupportedPackages function', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    const packages = result.current.getSupportedPackages();

    expect(packages).toContain('numpy');
    expect(packages).toContain('pandas');
    expect(packages).toContain('matplotlib');
  });

  it('should auto-detect packages if not provided', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    const { result } = renderHook(() => usePyodide('artifact-a'));

    await act(async () => {
      await result.current.execute('import numpy as np');
    });

    // detectPackages should have been called
    expect(pyodideManager.detectPackages).toHaveBeenCalledWith('import numpy as np');

    // execute should have been called with detected packages
    expect(pyodideManager.execute).toHaveBeenCalledWith('artifact-a', 'import numpy as np', ['numpy']);
  });

  it('should use provided packages if specified', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    const { result } = renderHook(() => usePyodide('artifact-a'));

    await act(async () => {
      await result.current.execute('x = 1', ['scipy']);
    });

    // execute should have been called with provided packages
    expect(pyodideManager.execute).toHaveBeenCalledWith('artifact-a', 'x = 1', ['scipy']);
  });

  it('should subscribe to state changes on mount', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    renderHook(() => usePyodide('artifact-a'));

    expect(pyodideManager.subscribe).toHaveBeenCalled();
  });

  it('should unsubscribe on unmount', async () => {
    const { pyodideManager } = await import('@client/app/utils/pyodideManager');
    const { usePyodide } = await import('../usePyodide');

    const unsubscribeMock = vi.fn();
    vi.mocked(pyodideManager.subscribe).mockReturnValue(unsubscribeMock);

    const { unmount } = renderHook(() => usePyodide('artifact-a'));

    unmount();

    expect(unsubscribeMock).toHaveBeenCalled();
  });

  it('should expose loadedPackages from state', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    expect(result.current.loadedPackages).toBeInstanceOf(Set);
  });

  it('should expose isExecuting from state', async () => {
    const { usePyodide } = await import('../usePyodide');
    const { result } = renderHook(() => usePyodide('artifact-a'));

    expect(typeof result.current.isExecuting).toBe('boolean');
    expect(result.current.isExecuting).toBe(false);
  });
});
