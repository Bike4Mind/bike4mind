/**
 * Verifies parallel execution of read-only tools and sequential execution of
 * write tools for the ReActAgent performance optimization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isReadOnlyTool,
  categorizeTools,
  executeToolsInParallel,
  getResultsInOrder,
  shouldUseParallelExecution,
  type ToolUseInfo,
  type ToolExecutionPlan,
} from './toolParallelizer.js';

describe('toolParallelizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isReadOnlyTool', () => {
    it('should return true for auto_approve tools', () => {
      expect(isReadOnlyTool('math_evaluate')).toBe(true);
      expect(isReadOnlyTool('current_datetime')).toBe(true);
      expect(isReadOnlyTool('dice_roll')).toBe(true);
    });

    it('should return true for prompt_default tools (read-only)', () => {
      expect(isReadOnlyTool('file_read')).toBe(true);
      expect(isReadOnlyTool('grep_search')).toBe(true);
      expect(isReadOnlyTool('glob_files')).toBe(true);
      expect(isReadOnlyTool('git_status')).toBe(true);
      expect(isReadOnlyTool('git_diff')).toBe(true);
    });

    it('should return false for prompt_always tools (write operations)', () => {
      expect(isReadOnlyTool('edit_file')).toBe(false);
      expect(isReadOnlyTool('edit_local_file')).toBe(false);
      expect(isReadOnlyTool('create_file')).toBe(false);
      expect(isReadOnlyTool('delete_file')).toBe(false);
      expect(isReadOnlyTool('bash_execute')).toBe(false);
      expect(isReadOnlyTool('shell_execute')).toBe(false);
    });

    it('should return true for unknown tools (default to prompt_default)', () => {
      // Unknown tools default to prompt_default which is read-only
      expect(isReadOnlyTool('unknown_tool')).toBe(true);
    });

    it('should respect custom category overrides', () => {
      const customCategories = {
        file_read: 'prompt_always' as const,
        custom_safe_tool: 'auto_approve' as const,
      };

      // file_read is normally read-only but overridden to write
      expect(isReadOnlyTool('file_read', customCategories)).toBe(false);
      // custom tool marked as safe
      expect(isReadOnlyTool('custom_safe_tool', customCategories)).toBe(true);
    });
  });

  describe('categorizeTools', () => {
    it('should put read-only tools in parallelBatch', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        { name: 'file_read', arguments: '{"path": "/b.txt"}' },
        { name: 'grep_search', arguments: '{"pattern": "test"}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.parallelBatch).toHaveLength(3);
      expect(plan.sequentialBatch).toHaveLength(0);
      expect(plan.parallelBatch.map(t => t.name)).toEqual(['file_read', 'file_read', 'grep_search']);
    });

    it('should put write tools in sequentialBatch', () => {
      const tools: ToolUseInfo[] = [
        { name: 'edit_file', arguments: '{"path": "/a.txt"}' },
        { name: 'create_file', arguments: '{"path": "/b.txt"}' },
        { name: 'bash_execute', arguments: '{"command": "ls"}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.parallelBatch).toHaveLength(0);
      expect(plan.sequentialBatch).toHaveLength(3);
      expect(plan.sequentialBatch.map(t => t.name)).toEqual(['edit_file', 'create_file', 'bash_execute']);
    });

    it('should separate mixed read/write tools correctly', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        { name: 'edit_file', arguments: '{"path": "/b.txt"}' },
        { name: 'grep_search', arguments: '{"pattern": "test"}' },
        { name: 'create_file', arguments: '{"path": "/c.txt"}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.parallelBatch).toHaveLength(2);
      expect(plan.sequentialBatch).toHaveLength(2);
      expect(plan.parallelBatch.map(t => t.name)).toEqual(['file_read', 'grep_search']);
      expect(plan.sequentialBatch.map(t => t.name)).toEqual(['edit_file', 'create_file']);
    });

    it('should use custom category overrides when provided', () => {
      const customCategories = {
        file_read: 'prompt_always' as const, // Override: treat as write
        custom_safe: 'auto_approve' as const, // Custom tool: treat as read-only
      };

      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{}' },
        { name: 'custom_safe', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
      ];

      const plan = categorizeTools(tools, customCategories);

      // file_read overridden to prompt_always -> sequential
      expect(plan.sequentialBatch.map(t => t.name)).toEqual(['file_read']);
      // custom_safe is auto_approve, grep_search is prompt_default -> parallel
      expect(plan.parallelBatch.map(t => t.name)).toEqual(['custom_safe', 'grep_search']);
    });

    it('should preserve original order in originalOrder array', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        { name: 'edit_file', arguments: '{"path": "/b.txt"}' },
        { name: 'grep_search', arguments: '{"pattern": "test"}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.originalOrder).toHaveLength(3);
      expect(plan.originalOrder[0]).toContain('file_read');
      expect(plan.originalOrder[1]).toContain('edit_file');
      expect(plan.originalOrder[2]).toContain('grep_search');
    });
  });

  describe('executeToolsInParallel', () => {
    it('should execute multiple read-only tools in parallel', async () => {
      const executionOrder: string[] = [];
      const executor = vi.fn(async (tool: ToolUseInfo) => {
        executionOrder.push(`start:${tool.name}`);
        // Simulate varying execution times
        await new Promise(r => setTimeout(r, tool.name === 'tool_a' ? 50 : 10));
        executionOrder.push(`end:${tool.name}`);
        return `result:${tool.name}`;
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [
          { name: 'tool_a', arguments: '{}' },
          { name: 'tool_b', arguments: '{}' },
        ],
        sequentialBatch: [],
        originalOrder: ['tool_a_"{}"', 'tool_b_"{}"'],
      };

      const results = await executeToolsInParallel(plan, executor);

      // Both should start before either ends (parallel execution)
      expect(executionOrder.indexOf('start:tool_a')).toBeLessThan(executionOrder.indexOf('end:tool_a'));
      expect(executionOrder.indexOf('start:tool_b')).toBeLessThan(executionOrder.indexOf('end:tool_b'));

      // tool_b should complete before tool_a (faster execution)
      expect(executionOrder.indexOf('end:tool_b')).toBeLessThan(executionOrder.indexOf('end:tool_a'));

      expect(results.size).toBe(2);
      expect(results.get('tool_a_"{}"')?.result).toBe('result:tool_a');
      expect(results.get('tool_b_"{}"')?.result).toBe('result:tool_b');
    });

    it('should execute write tools sequentially after parallel batch', async () => {
      const executionOrder: string[] = [];
      const executor = vi.fn(async (tool: ToolUseInfo) => {
        executionOrder.push(`start:${tool.name}`);
        await new Promise(r => setTimeout(r, 10));
        executionOrder.push(`end:${tool.name}`);
        return `result:${tool.name}`;
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [{ name: 'read_tool', arguments: '{}' }],
        sequentialBatch: [
          { name: 'write_a', arguments: '{}' },
          { name: 'write_b', arguments: '{}' },
        ],
        originalOrder: ['read_tool_"{}"', 'write_a_"{}"', 'write_b_"{}"'],
      };

      const results = await executeToolsInParallel(plan, executor);

      // Parallel batch should complete before sequential batch starts
      expect(executionOrder.indexOf('end:read_tool')).toBeLessThan(executionOrder.indexOf('start:write_a'));

      // Sequential tools should not overlap
      expect(executionOrder.indexOf('end:write_a')).toBeLessThan(executionOrder.indexOf('start:write_b'));

      expect(results.size).toBe(3);
    });

    it('should not block other tools when one tool fails', async () => {
      const executor = vi.fn(async (tool: ToolUseInfo) => {
        if (tool.name === 'failing_tool') {
          throw new Error('Tool failed');
        }
        return `result:${tool.name}`;
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [
          { name: 'working_tool', arguments: '{}' },
          { name: 'failing_tool', arguments: '{}' },
        ],
        sequentialBatch: [],
        originalOrder: ['working_tool_"{}"', 'failing_tool_"{}"'],
      };

      const results = await executeToolsInParallel(plan, executor);

      expect(results.size).toBe(2);

      const workingResult = results.get('working_tool_"{}"');
      expect(workingResult?.status).toBe('fulfilled');
      expect(workingResult?.result).toBe('result:working_tool');

      const failingResult = results.get('failing_tool_"{}"');
      expect(failingResult?.status).toBe('rejected');
      expect(failingResult?.error?.message).toBe('Tool failed');
    });

    it('should handle abort signal', async () => {
      const abortController = new AbortController();

      const executor = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 100));
        return 'result';
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [{ name: 'slow_tool', arguments: '{}' }],
        sequentialBatch: [],
        originalOrder: ['slow_tool_"{}"'],
      };

      // Abort immediately
      abortController.abort();

      await expect(executeToolsInParallel(plan, executor, abortController.signal)).rejects.toThrow(
        'Tool execution aborted'
      );
    });

    it('should return empty map for empty plan', async () => {
      const executor = vi.fn();
      const plan: ToolExecutionPlan = {
        parallelBatch: [],
        sequentialBatch: [],
        originalOrder: [],
      };

      const results = await executeToolsInParallel(plan, executor);

      expect(results.size).toBe(0);
      expect(executor).not.toHaveBeenCalled();
    });

    it('should handle duplicate tool IDs (same name + args) — last result wins in Map', async () => {
      let callCount = 0;
      const executor = vi.fn(async (tool: ToolUseInfo) => {
        callCount++;
        return `result_${callCount}_${tool.name}`;
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [
          { name: 'file_read', arguments: '{"path": "/same.txt"}' },
          { name: 'file_read', arguments: '{"path": "/same.txt"}' },
        ],
        sequentialBatch: [],
        originalOrder: ['file_read_"{\\"path\\": \\"/same.txt\\"}"', 'file_read_"{\\"path\\": \\"/same.txt\\"}"'],
      };

      const results = await executeToolsInParallel(plan, executor);

      // Both tools executed
      expect(executor).toHaveBeenCalledTimes(2);
      // But only 1 entry in Map due to identical keys
      expect(results.size).toBe(1);
    });

    it('should abort between sequential tools when signal fires mid-execution', async () => {
      const abortController = new AbortController();
      const executedTools: string[] = [];

      const executor = vi.fn(async (tool: ToolUseInfo) => {
        executedTools.push(tool.name);
        if (tool.name === 'write_a') {
          abortController.abort();
        }
        return `result:${tool.name}`;
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [],
        sequentialBatch: [
          { name: 'write_a', arguments: '{}' },
          { name: 'write_b', arguments: '{}' },
        ],
        originalOrder: ['write_a_"{}"', 'write_b_"{}"'],
      };

      await expect(executeToolsInParallel(plan, executor, abortController.signal)).rejects.toThrow(
        'Tool execution aborted'
      );

      expect(executedTools).toContain('write_a');
      expect(executedTools).not.toContain('write_b');
    });
  });

  describe('getResultsInOrder', () => {
    it('should return results in original order', () => {
      const results = new Map([
        ['tool_c_"{}"', { toolName: 'tool_c', result: 'result_c', status: 'fulfilled' as const }],
        ['tool_a_"{}"', { toolName: 'tool_a', result: 'result_a', status: 'fulfilled' as const }],
        ['tool_b_"{}"', { toolName: 'tool_b', result: 'result_b', status: 'fulfilled' as const }],
      ]);

      const originalOrder = ['tool_a_"{}"', 'tool_b_"{}"', 'tool_c_"{}"'];

      const ordered = getResultsInOrder(results, originalOrder);

      expect(ordered).toHaveLength(3);
      expect(ordered[0].toolName).toBe('tool_a');
      expect(ordered[1].toolName).toBe('tool_b');
      expect(ordered[2].toolName).toBe('tool_c');
    });

    it('should skip missing results', () => {
      const results = new Map([
        ['tool_a_"{}"', { toolName: 'tool_a', result: 'result_a', status: 'fulfilled' as const }],
      ]);

      const originalOrder = ['tool_a_"{}"', 'tool_b_"{}"'];

      const ordered = getResultsInOrder(results, originalOrder);

      expect(ordered).toHaveLength(1);
      expect(ordered[0].toolName).toBe('tool_a');
    });
  });

  describe('shouldUseParallelExecution', () => {
    it('should return false for single tool', () => {
      const tools: ToolUseInfo[] = [{ name: 'file_read', arguments: '{}' }];

      expect(shouldUseParallelExecution(tools)).toBe(false);
    });

    it('should return false for empty tools', () => {
      expect(shouldUseParallelExecution([])).toBe(false);
    });

    it('should return true for 2+ read-only tools', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        { name: 'file_read', arguments: '{"path": "/b.txt"}' },
      ];

      expect(shouldUseParallelExecution(tools)).toBe(true);
    });

    it('should return true for 3+ read-only tools', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
        { name: 'glob_files', arguments: '{}' },
      ];

      expect(shouldUseParallelExecution(tools)).toBe(true);
    });

    it('should return false for only write tools', () => {
      const tools: ToolUseInfo[] = [
        { name: 'edit_file', arguments: '{}' },
        { name: 'create_file', arguments: '{}' },
      ];

      expect(shouldUseParallelExecution(tools)).toBe(false);
    });

    it('should return true for mixed tools with 2+ read-only', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
        { name: 'edit_file', arguments: '{}' },
      ];

      expect(shouldUseParallelExecution(tools)).toBe(true);
    });

    it('should return false for mixed tools with only 1 read-only', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{}' },
        { name: 'edit_file', arguments: '{}' },
        { name: 'create_file', arguments: '{}' },
      ];

      expect(shouldUseParallelExecution(tools)).toBe(false);
    });
  });

  describe('integration: timing verification', () => {
    it('should complete parallel execution faster than sequential', async () => {
      const TOOL_DELAY = 50; // ms per tool

      const executor = vi.fn(async () => {
        await new Promise(r => setTimeout(r, TOOL_DELAY));
        return 'result';
      });

      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        { name: 'file_read', arguments: '{"path": "/b.txt"}' },
        { name: 'file_read', arguments: '{"path": "/c.txt"}' },
      ];

      const plan = categorizeTools(tools);

      // Measure a sequential baseline and the parallel run back-to-back under
      // the same CPU conditions, then assert the relationship rather than a
      // fixed wall-clock threshold. An absolute bound (e.g. < 2 * TOOL_DELAY)
      // is fragile under CI contention - a starved event loop fires the delay
      // timers late, so the parallel run can drift past the bound (observed:
      // 102ms vs a 100ms cap). Comparing two measurements taken together is
      // robust to that variance because both inflate proportionally.
      const sequentialStart = Date.now();
      for (let i = 0; i < tools.length; i++) {
        await executor();
      }
      const sequentialDuration = Date.now() - sequentialStart;

      const parallelStart = Date.now();
      await executeToolsInParallel(plan, executor);
      const parallelDuration = Date.now() - parallelStart;

      // Parallel overlaps the per-tool delays (~TOOL_DELAY total) while
      // sequential sums them (~tools.length * TOOL_DELAY), so parallel must be
      // meaningfully faster - half the sequential time leaves wide margin while
      // still catching a regression that silently serializes execution.
      expect(parallelDuration).toBeLessThan(sequentialDuration / 2);
    });
  });
});
