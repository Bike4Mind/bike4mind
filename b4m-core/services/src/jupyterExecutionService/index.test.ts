import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  JupyterExecutionService,
  createJupyterExecutionService,
  JupyterExecutionAdapters,
  validateNotebookPath,
  validateKernelName,
} from './index';
import { createEmptyNotebook, addCodeCell } from '../llm/tools/implementation/jupyterNotebook/notebookStructure';

describe('JupyterExecutionService', () => {
  describe('validateNotebookPath', () => {
    it('should accept valid paths', () => {
      expect(validateNotebookPath('/home/user/notebook.ipynb')).toEqual({ valid: true });
      expect(validateNotebookPath('analysis.ipynb')).toEqual({ valid: true });
      expect(validateNotebookPath('/path/to/my-notebook.ipynb')).toEqual({ valid: true });
    });

    it('should reject empty path', () => {
      const result = validateNotebookPath('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject path traversal', () => {
      const result = validateNotebookPath('../../../etc/passwd.ipynb');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('path traversal');
    });

    it('should reject double slashes', () => {
      const result = validateNotebookPath('/home//user/notebook.ipynb');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('path traversal');
    });

    it('should reject non-ipynb files', () => {
      const result = validateNotebookPath('/home/user/script.py');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must end with .ipynb');
    });

    it('should reject paths with control characters', () => {
      const result = validateNotebookPath('/home/user/notebook\x00.ipynb');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('control characters');
    });
  });

  describe('validateKernelName', () => {
    it('should accept allowed kernels', () => {
      expect(validateKernelName('python3')).toEqual({ valid: true });
      expect(validateKernelName('python')).toEqual({ valid: true });
      expect(validateKernelName('ir')).toEqual({ valid: true });
      expect(validateKernelName('julia-1.9')).toEqual({ valid: true });
    });

    it('should reject empty kernel name', () => {
      const result = validateKernelName('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject unknown kernels', () => {
      const result = validateKernelName('malicious-kernel');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid kernel');
      expect(result.error).toContain('Allowed kernels');
    });
  });

  describe('executeNotebook', () => {
    let mockAdapters: JupyterExecutionAdapters;
    let service: JupyterExecutionService;

    beforeEach(() => {
      mockAdapters = {
        sendKeepCommand: vi.fn(),
        onProgress: vi.fn().mockResolvedValue(undefined),
        onCellOutput: vi.fn().mockResolvedValue(undefined),
        llm: {
          complete: vi.fn().mockResolvedValue(undefined),
        },
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        } as any,
      };
      service = createJupyterExecutionService(mockAdapters);
    });

    it('should fail for invalid notebook path', async () => {
      const notebook = createEmptyNotebook();

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: '../etc/passwd',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('path traversal');
      expect(mockAdapters.sendKeepCommand).not.toHaveBeenCalled();
    });

    it('should fail for invalid kernel name', async () => {
      const notebook = createEmptyNotebook();

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'valid.ipynb',
        kernelName: 'evil-kernel',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid kernel');
    });

    it('should fail for notebooks exceeding cell limit', async () => {
      const notebook = createEmptyNotebook();
      for (let i = 0; i < 250; i++) {
        addCodeCell(notebook, `cell ${i}`);
      }

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'valid.ipynb',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum');
    });

    it('should handle kernel start failure', async () => {
      vi.mocked(mockAdapters.sendKeepCommand).mockResolvedValueOnce({
        success: false,
        error: 'Jupyter server not running',
      });

      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'print("test")');

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'test.ipynb',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Jupyter server not running');
      expect(mockAdapters.onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });

    it('should validate session response structure', async () => {
      vi.mocked(mockAdapters.sendKeepCommand).mockResolvedValueOnce({
        success: true,
        result: { invalid: 'structure' }, // Missing id and kernel.id
      });

      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'print("test")');

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'test.ipynb',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid Jupyter session response');
    });

    it('should execute cells successfully', async () => {
      // Mock kernel start
      vi.mocked(mockAdapters.sendKeepCommand)
        .mockResolvedValueOnce({
          success: true,
          result: { id: 'session-123', kernel: { id: 'kernel-456' } },
        })
        // Mock cell execution
        .mockResolvedValueOnce({
          success: true,
          result: {
            outputs: [{ output_type: 'stream', name: 'stdout', text: 'Hello\n' }],
          },
        })
        // Mock kernel stop
        .mockResolvedValueOnce({ success: true });

      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'print("Hello")');

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'test.ipynb',
      });

      expect(result.success).toBe(true);
      expect(result.cellsExecuted).toBe(1);
      expect(result.cellsFailed).toBe(0);
      expect(notebook.cells[0].outputs).toHaveLength(1);
    });

    it('should skip empty code cells', async () => {
      vi.mocked(mockAdapters.sendKeepCommand)
        .mockResolvedValueOnce({
          success: true,
          result: { id: 'session-123', kernel: { id: 'kernel-456' } },
        })
        .mockResolvedValueOnce({ success: true });

      const notebook = createEmptyNotebook();
      addCodeCell(notebook, '   '); // Empty whitespace
      addCodeCell(notebook, ''); // Empty string

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'test.ipynb',
      });

      expect(result.success).toBe(true);
      expect(result.cellsExecuted).toBe(0);
      // Should only have start and stop kernel calls, no execute calls
      expect(mockAdapters.sendKeepCommand).toHaveBeenCalledTimes(2);
    });

    it('should timeout on slow cell execution', async () => {
      vi.mocked(mockAdapters.sendKeepCommand)
        .mockResolvedValueOnce({
          success: true,
          result: { id: 'session-123', kernel: { id: 'kernel-456' } },
        })
        // Cell execution that never resolves
        .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ success: true }), 10000)))
        .mockResolvedValue({ success: true });

      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'import time; time.sleep(100)');

      const result = await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'test.ipynb',
        timeoutPerCell: 100, // 100ms timeout
        maxCellRetries: 0, // No retries
      });

      expect(result.cellsFailed).toBe(1);
    }, 10000);

    it('should send progress updates', async () => {
      vi.mocked(mockAdapters.sendKeepCommand)
        .mockResolvedValueOnce({
          success: true,
          result: { id: 'session-123', kernel: { id: 'kernel-456' } },
        })
        .mockResolvedValueOnce({
          success: true,
          result: { outputs: [] },
        })
        .mockResolvedValueOnce({ success: true });

      const notebook = createEmptyNotebook();
      addCodeCell(notebook, 'x = 1');

      await service.executeNotebook(notebook, {
        questId: 'quest-1',
        sessionId: 'session-1',
        notebookPath: 'test.ipynb',
      });

      // Check progress updates were sent
      expect(mockAdapters.onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'kernel_starting' }));
      expect(mockAdapters.onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'executing' }));
      expect(mockAdapters.onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'cell_complete' }));
      expect(mockAdapters.onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    });
  });

  describe('createJupyterExecutionService', () => {
    it('should create a service instance', () => {
      const mockAdapters: JupyterExecutionAdapters = {
        sendKeepCommand: vi.fn(),
        onProgress: vi.fn(),
        onCellOutput: vi.fn(),
        llm: { complete: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      };

      const service = createJupyterExecutionService(mockAdapters);
      expect(service).toBeInstanceOf(JupyterExecutionService);
    });
  });
});
