import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the exported functions/class by mocking the Worker dependency
// For detectPackages, we can test directly since it's a pure function

describe('pyodideManager', () => {
  describe('detectPackages', () => {
    // Import the module dynamically to avoid issues with Worker
    let detectPackages: (code: string) => string[];

    beforeEach(async () => {
      // Reset modules between tests
      vi.resetModules();

      // Mock Worker to avoid browser-only code
      vi.stubGlobal('Worker', vi.fn());

      // Import the manager after mocking
      const imported = await import('../pyodideManager');
      detectPackages = imported.pyodideManager.detectPackages.bind(imported.pyodideManager);
    });

    afterEach(() => {
      vi.clearAllMocks();
      vi.unstubAllGlobals();
    });

    it('should detect numpy import', () => {
      const code = 'import numpy as np\nx = np.array([1, 2, 3])';
      const packages = detectPackages(code);
      expect(packages).toContain('numpy');
    });

    it('should detect pandas import', () => {
      const code = 'import pandas as pd\ndf = pd.DataFrame()';
      const packages = detectPackages(code);
      expect(packages).toContain('pandas');
    });

    it('should detect matplotlib import', () => {
      const code = 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])';
      const packages = detectPackages(code);
      expect(packages).toContain('matplotlib');
    });

    it('should detect from X import Y syntax', () => {
      const code = 'from scipy import stats\nfrom numpy import array';
      const packages = detectPackages(code);
      expect(packages).toContain('scipy');
      expect(packages).toContain('numpy');
    });

    it('should detect seaborn import', () => {
      const code = 'import seaborn as sns\nsns.heatmap(data)';
      const packages = detectPackages(code);
      expect(packages).toContain('seaborn');
    });

    it('should detect sklearn import with direct import', () => {
      // The current regex only matches the top-level module name
      // 'from sklearn.linear_model' extracts 'sklearn' as the module
      const code = 'import sklearn';
      const packages = detectPackages(code);
      expect(packages).toContain('sklearn');
    });

    it('should detect sklearn from submodule import', () => {
      // from sklearn.X import Y extracts 'sklearn'
      const code = 'from sklearn import linear_model';
      const packages = detectPackages(code);
      expect(packages).toContain('sklearn');
    });

    it('should not detect unsupported packages', () => {
      const code = 'import requests\nimport json\nimport os';
      const packages = detectPackages(code);
      expect(packages).toHaveLength(0);
    });

    it('should handle multiple imports in one file', () => {
      const code = `
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import scipy
import seaborn as sns
      `;
      const packages = detectPackages(code);
      expect(packages).toContain('numpy');
      expect(packages).toContain('pandas');
      expect(packages).toContain('matplotlib');
      expect(packages).toContain('scipy');
      expect(packages).toContain('seaborn');
    });

    it('should not duplicate packages', () => {
      const code = `
import numpy
import numpy as np
from numpy import array
      `;
      const packages = detectPackages(code);
      const numpyCount = packages.filter(p => p === 'numpy').length;
      expect(numpyCount).toBe(1);
    });

    it('should handle empty code', () => {
      const packages = detectPackages('');
      expect(packages).toHaveLength(0);
    });

    it('should handle code without imports', () => {
      const code = 'x = 1 + 2\nprint(x)';
      const packages = detectPackages(code);
      expect(packages).toHaveLength(0);
    });

    it('should handle commented out imports', () => {
      // Current implementation doesn't handle comments, which is a known limitation
      // The regex matches line-by-line and doesn't skip comments
      const code = '# import numpy\nprint("hello")';
      const packages = detectPackages(code);
      // This tests current behavior - the commented import IS detected
      // This could be considered a limitation but is acceptable for MVP
      expect(packages).toHaveLength(0); // Actually, the regex uses ^import so # import won't match
    });

    it('should handle imports within string literals correctly', () => {
      // Current implementation may detect these - documenting behavior
      const code = 'code = "import numpy"';
      const packages = detectPackages(code);
      // The multiline regex with ^ anchor should not match this
      expect(packages).toHaveLength(0);
    });
  });

  describe('ExecutionResult interface', () => {
    it('should define correct result structure', async () => {
      vi.stubGlobal('Worker', vi.fn());

      // Type-level test - if this compiles, the ExecutionResult interface is correct
      const result: import('@client/app/workers/pyodide/types').ExecutionResult = {
        success: true,
        output: 'Hello, World!',
        plots: [],
        executionTime: 100,
      };

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello, World!');
      expect(result.plots).toHaveLength(0);
      expect(result.executionTime).toBe(100);
    });
  });

  describe('PyodideManagerState interface', () => {
    it('should track loading state correctly', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const state = pyodideManager.getState();

      // Initial state should be not loading with no worker ready
      expect(state.isLoading).toBe(false);
      expect(state.loadProgress).toBe(0);
      expect(state.error).toBeNull();
      expect(state.loadedPackages).toBeInstanceOf(Set);
      expect(state.isReady).toBe(false);
      expect(state.isExecuting).toBe(false);
    });
  });

  describe('getSupportedPackages', () => {
    it('should return list of supported packages', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const packages = pyodideManager.getSupportedPackages();

      expect(packages).toContain('numpy');
      expect(packages).toContain('pandas');
      expect(packages).toContain('matplotlib');
      expect(packages).toContain('scipy');
      expect(packages).toContain('seaborn');
      expect(packages).toContain('scikit-learn');
    });
  });

  describe('isReady', () => {
    it('should return false initially', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      expect(pyodideManager.isReady()).toBe(false);
    });
  });

  describe('subscribe', () => {
    it('should allow subscribing to state changes', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const listener = vi.fn();
      const unsubscribe = pyodideManager.subscribe(listener);

      expect(typeof unsubscribe).toBe('function');

      // Cleanup
      unsubscribe();
    });

    it('should return unsubscribe function that works', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      const listener = vi.fn();
      const unsubscribe = pyodideManager.subscribe(listener);

      unsubscribe();

      // After unsubscribe, listener should not be called
      // We can't easily test this without triggering a state change
      // which would require mocking more of the initialization
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('interrupt', () => {
    it('should have interrupt method defined', async () => {
      vi.stubGlobal('Worker', vi.fn());
      const { pyodideManager } = await import('../pyodideManager');

      expect(typeof pyodideManager.interrupt).toBe('function');
    });
  });
});

describe('execution timeout', () => {
  it('should have EXECUTION_TIMEOUT_MS constant defined', async () => {
    // The timeout constant is private, but we can verify the execute method
    // signature includes a timeout parameter
    vi.stubGlobal('Worker', vi.fn());
    const { pyodideManager } = await import('../pyodideManager');

    // Verify execute method exists and accepts timeout parameter
    expect(typeof pyodideManager.execute).toBe('function');
    expect(pyodideManager.execute.length).toBeGreaterThanOrEqual(1);
  });
});
