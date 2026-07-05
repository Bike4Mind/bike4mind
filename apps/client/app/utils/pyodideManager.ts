/**
 * Pyodide Manager - Singleton utility for browser-based Python execution
 *
 * Uses a Web Worker to run Pyodide off the main thread, allowing:
 * 1. UI remains responsive during execution
 * 2. Infinite loops can be interrupted by terminating the worker
 * 3. Long calculations don't freeze the browser
 *
 * Handles:
 * 1. Worker lifecycle management
 * 2. Package installation via micropip
 * 3. Code execution with stdout/stderr capture
 * 4. Matplotlib plot generation as base64 PNG
 * 5. Execution interruption via worker termination
 */

import type { PyodideWorkerMessage, PyodideWorkerResponse, ExecutionResult } from '@client/app/workers/pyodide/types';

// Re-export ExecutionResult for backwards compatibility
export type { ExecutionResult } from '@client/app/workers/pyodide/types';

/** Default execution timeout in milliseconds (30 seconds) */
const EXECUTION_TIMEOUT_MS = 30000;

export interface PyodideManagerState {
  isLoading: boolean;
  loadProgress: number;
  loadedPackages: Set<string>;
  error: string | null;
  isReady: boolean;
  isExecuting: boolean;
  streamingOutput: string;
}

// Supported packages (pre-built in Pyodide)
const SUPPORTED_PACKAGES = ['numpy', 'pandas', 'matplotlib', 'scipy', 'seaborn', 'scikit-learn'];

// Package name mapping (npm name -> Pyodide package name)
const PACKAGE_NAME_MAP: Record<string, string> = {
  'scikit-learn': 'sklearn',
  sklearn: 'sklearn',
};

class PyodideManager {
  private state: PyodideManagerState = {
    isLoading: false,
    loadProgress: 0,
    loadedPackages: new Set(),
    error: null,
    isReady: false,
    isExecuting: false,
    streamingOutput: '',
  };

  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private executeResolver: ((result: ExecutionResult) => void) | null = null;
  private executeRejecter: ((error: Error) => void) | null = null;
  private listeners: Set<(state: PyodideManagerState) => void> = new Set();

  private spawnWorker(): Worker {
    const worker = new Worker(new URL('../workers/pyodide/pyodide.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<PyodideWorkerResponse>) => {
      this.handleWorkerMessage(e.data);
    };

    worker.onerror = error => {
      console.error('[PyodideManager] Worker error:', error);
      this.updateState({ error: error.message || 'Worker error', isLoading: false, isExecuting: false });

      if (this.executeRejecter) {
        this.executeRejecter(new Error(error.message || 'Worker error'));
        this.executeResolver = null;
        this.executeRejecter = null;
      }
    };

    return worker;
  }

  private handleWorkerMessage(msg: PyodideWorkerResponse): void {
    switch (msg.type) {
      case 'initializing':
        this.updateState({
          isLoading: true,
          loadProgress: msg.progress,
          error: null,
        });
        break;

      case 'ready':
        this.updateState({
          isLoading: false,
          loadProgress: 100,
          isReady: true,
          error: null,
        });
        break;

      case 'executing':
        this.updateState({ isExecuting: true, streamingOutput: '' });
        break;

      case 'output':
        this.updateState({
          streamingOutput: this.state.streamingOutput + msg.output,
        });
        break;

      case 'result':
        this.updateState({ isExecuting: false });
        if (this.executeResolver) {
          this.executeResolver(msg.result);
          this.executeResolver = null;
          this.executeRejecter = null;
        }
        break;

      case 'error':
        this.updateState({
          isLoading: false,
          isExecuting: false,
          error: msg.error,
        });
        if (this.executeRejecter) {
          this.executeRejecter(new Error(msg.error));
          this.executeResolver = null;
          this.executeRejecter = null;
        }
        break;
    }
  }

  /**
   * Initialize Pyodide (lazy-loaded singleton)
   */
  async initialize(): Promise<void> {
    if (this.state.isReady && this.worker) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise<void>((resolve, reject) => {
      if (!this.worker) {
        this.worker = this.spawnWorker();
      }

      const originalHandler = this.worker.onmessage;
      this.worker.onmessage = (e: MessageEvent<PyodideWorkerResponse>) => {
        // Call original handler for state updates
        this.handleWorkerMessage(e.data);

        if (e.data.type === 'ready') {
          this.worker!.onmessage = originalHandler;
          resolve();
        } else if (e.data.type === 'error') {
          this.worker!.onmessage = originalHandler;
          this.initPromise = null;
          reject(new Error(e.data.error));
        }
      };

      const message: PyodideWorkerMessage = { type: 'initialize' };
      this.worker.postMessage(message);
    });

    return this.initPromise;
  }

  /**
   * Execute Python code and capture output.
   * Runs in a Web Worker so it won't freeze the UI.
   * Use interrupt() to stop execution (e.g., for infinite loops).
   *
   * @param code - Python code to execute
   * @param packages - Optional list of packages to load before execution
   * @param timeoutMs - Execution timeout in milliseconds (default: 30s)
   */
  async execute(code: string, packages: string[] = [], timeoutMs = EXECUTION_TIMEOUT_MS): Promise<ExecutionResult> {
    await this.initialize();

    if (!this.worker) {
      throw new Error('Worker not available');
    }

    return new Promise<ExecutionResult>((resolve, reject) => {
      this.executeResolver = resolve;
      this.executeRejecter = reject;

      this.updateState({ isExecuting: true });

      const message: PyodideWorkerMessage = {
        type: 'execute',
        code,
        packages,
        timeoutMs,
      };
      this.worker!.postMessage(message);
    });
  }

  /**
   * Interrupt the current execution by terminating the worker.
   * This immediately stops infinite loops or long-running code.
   * A new worker will be spawned on the next execution.
   */
  interrupt(): void {
    if (!this.worker) {
      return;
    }

    this.worker.terminate();
    this.worker = null;
    this.initPromise = null;

    this.updateState({
      isExecuting: false,
      isReady: false,
      loadProgress: 0,
      loadedPackages: new Set(),
    });

    // Resolve pending execution with cancellation (include any output captured before interrupt)
    if (this.executeResolver) {
      this.executeResolver({
        success: false,
        output: this.state.streamingOutput,
        error: 'Execution interrupted',
        plots: [],
        executionTime: 0,
      });
      this.executeResolver = null;
      this.executeRejecter = null;
    }

    // Re-initialize so the Run button becomes enabled again
    this.initialize().catch(console.error);
  }

  /** Detect required packages from import statements. */
  detectPackages(code: string): string[] {
    const packages: Set<string> = new Set();

    const importPatterns = [/^import\s+(\w+)/gm, /^from\s+(\w+)\s+import/gm];

    for (const pattern of importPatterns) {
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const pkg = match[1];
        if (
          SUPPORTED_PACKAGES.includes(pkg) ||
          Object.keys(PACKAGE_NAME_MAP).includes(pkg) ||
          Object.values(PACKAGE_NAME_MAP).includes(pkg)
        ) {
          packages.add(pkg);
        }
      }
    }

    return Array.from(packages);
  }

  private updateState(partial: Partial<PyodideManagerState>): void {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach(listener => listener(this.state));
  }

  subscribe(listener: (state: PyodideManagerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PyodideManagerState {
    return this.state;
  }

  isReady(): boolean {
    return this.state.isReady && !this.state.isLoading;
  }

  getSupportedPackages(): string[] {
    return [...SUPPORTED_PACKAGES];
  }
}

export const pyodideManager = new PyodideManager();
