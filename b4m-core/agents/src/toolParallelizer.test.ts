/**
 * Unit Tests for agents-package Tool Parallelizer Module
 *
 * Tests the core parallelization utilities used by ReActAgent:
 * - defaultIsReadOnlyTool / DEFAULT_WRITE_TOOLS
 * - getToolId
 * - categorizeTools
 * - executeToolsInParallel
 * - getResultsInOrder
 * - shouldUseParallelExecution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  defaultIsReadOnlyTool,
  DEFAULT_WRITE_TOOLS,
  getToolId,
  categorizeTools,
  executeToolsInParallel,
  getResultsInOrder,
  shouldUseParallelExecution,
  type ToolUseInfo,
  type ToolExecutionPlan,
} from './toolParallelizer';

describe('toolParallelizer (agents package)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('defaultIsReadOnlyTool', () => {
    it('should return false for all known write tools', () => {
      for (const writeTool of DEFAULT_WRITE_TOOLS) {
        expect(defaultIsReadOnlyTool(writeTool)).toBe(false);
      }
    });

    it('should return true for common read-only tools', () => {
      const readOnlyTools = ['file_read', 'grep_search', 'glob_files', 'git_status', 'git_diff'];
      for (const tool of readOnlyTools) {
        expect(defaultIsReadOnlyTool(tool)).toBe(true);
      }
    });

    it('should return true for unknown tools (not in write set)', () => {
      expect(defaultIsReadOnlyTool('completely_unknown_tool')).toBe(true);
    });

    it('should contain all expected write tools', () => {
      const expectedWriteTools = [
        'edit_file',
        'edit_local_file',
        'create_file',
        'delete_file',
        'shell_execute',
        'bash_execute',
        'git_commit',
        'git_push',
      ];
      for (const tool of expectedWriteTools) {
        expect(DEFAULT_WRITE_TOOLS.has(tool)).toBe(true);
      }
      expect(DEFAULT_WRITE_TOOLS.size).toBe(expectedWriteTools.length);
    });
  });

  describe('getToolId', () => {
    it('should create unique IDs from name and arguments', () => {
      const tool: ToolUseInfo = { name: 'file_read', arguments: '{"path": "/a.txt"}' };
      expect(getToolId(tool)).toBe('file_read_"{\\"path\\": \\"/a.txt\\"}"');
    });

    it('should produce the same ID for identical tool calls', () => {
      const tool1: ToolUseInfo = { name: 'file_read', arguments: '{}' };
      const tool2: ToolUseInfo = { name: 'file_read', arguments: '{}' };
      expect(getToolId(tool1)).toBe(getToolId(tool2));
    });

    it('should produce different IDs for different arguments', () => {
      const tool1: ToolUseInfo = { name: 'file_read', arguments: '{"path": "/a.txt"}' };
      const tool2: ToolUseInfo = { name: 'file_read', arguments: '{"path": "/b.txt"}' };
      expect(getToolId(tool1)).not.toBe(getToolId(tool2));
    });

    it('should handle undefined arguments', () => {
      const tool: ToolUseInfo = { name: 'file_read' };
      const id = getToolId(tool);
      expect(id).toBe('file_read_undefined');
    });

    it('should ignore the id field (API tool call ID)', () => {
      const tool1: ToolUseInfo = { name: 'file_read', arguments: '{}', id: 'toolu_abc' };
      const tool2: ToolUseInfo = { name: 'file_read', arguments: '{}', id: 'toolu_xyz' };
      // Same name + args = same tool ID, even with different API IDs
      expect(getToolId(tool1)).toBe(getToolId(tool2));
    });
  });

  describe('categorizeTools', () => {
    it('should put read-only tools in parallelBatch using default classifier', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        { name: 'grep_search', arguments: '{"pattern": "test"}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.parallelBatch).toHaveLength(2);
      expect(plan.sequentialBatch).toHaveLength(0);
    });

    it('should put write tools in sequentialBatch using default classifier', () => {
      const tools: ToolUseInfo[] = [
        { name: 'edit_file', arguments: '{}' },
        { name: 'delete_file', arguments: '{}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.parallelBatch).toHaveLength(0);
      expect(plan.sequentialBatch).toHaveLength(2);
    });

    it('should separate mixed tools correctly', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{}' },
        { name: 'edit_file', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.parallelBatch.map(t => t.name)).toEqual(['file_read', 'grep_search']);
      expect(plan.sequentialBatch.map(t => t.name)).toEqual(['edit_file']);
    });

    it('should preserve original order in originalOrder array', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        { name: 'edit_file', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
      ];

      const plan = categorizeTools(tools);

      expect(plan.originalOrder).toHaveLength(3);
      expect(plan.originalOrder[0]).toContain('file_read');
      expect(plan.originalOrder[1]).toContain('edit_file');
      expect(plan.originalOrder[2]).toContain('grep_search');
    });

    it('should use custom isReadOnly function when provided', () => {
      const tools: ToolUseInfo[] = [
        { name: 'custom_safe', arguments: '{}' },
        { name: 'custom_dangerous', arguments: '{}' },
      ];

      const customIsReadOnly = (name: string) => name === 'custom_safe';
      const plan = categorizeTools(tools, customIsReadOnly);

      expect(plan.parallelBatch.map(t => t.name)).toEqual(['custom_safe']);
      expect(plan.sequentialBatch.map(t => t.name)).toEqual(['custom_dangerous']);
    });

    it('should handle empty tools array', () => {
      const plan = categorizeTools([]);

      expect(plan.parallelBatch).toHaveLength(0);
      expect(plan.sequentialBatch).toHaveLength(0);
      expect(plan.originalOrder).toHaveLength(0);
    });
  });

  describe('executeToolsInParallel', () => {
    it('should execute read-only tools in parallel', async () => {
      const executionOrder: string[] = [];
      const executor = vi.fn(async (tool: ToolUseInfo) => {
        executionOrder.push(`start:${tool.name}`);
        await new Promise(r => setTimeout(r, tool.name === 'slow' ? 50 : 10));
        executionOrder.push(`end:${tool.name}`);
        return `result:${tool.name}`;
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [
          { name: 'slow', arguments: '{}' },
          { name: 'fast', arguments: '{}' },
        ],
        sequentialBatch: [],
        originalOrder: ['slow_"{}"', 'fast_"{}"'],
      };

      const results = await executeToolsInParallel(plan, executor);

      // fast should end before slow (parallel)
      expect(executionOrder.indexOf('end:fast')).toBeLessThan(executionOrder.indexOf('end:slow'));
      expect(results.size).toBe(2);
    });

    it('should execute sequential tools after parallel batch', async () => {
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

      expect(executionOrder.indexOf('end:read_tool')).toBeLessThan(executionOrder.indexOf('start:write_a'));
      expect(executionOrder.indexOf('end:write_a')).toBeLessThan(executionOrder.indexOf('start:write_b'));
      expect(results.size).toBe(3);
    });

    it('should isolate failures — one tool error does not block others', async () => {
      const executor = vi.fn(async (tool: ToolUseInfo) => {
        if (tool.name === 'failing') throw new Error('boom');
        return `result:${tool.name}`;
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [
          { name: 'working', arguments: '{}' },
          { name: 'failing', arguments: '{}' },
        ],
        sequentialBatch: [],
        originalOrder: ['working_"{}"', 'failing_"{}"'],
      };

      const results = await executeToolsInParallel(plan, executor);

      expect(results.get('working_"{}"')?.status).toBe('fulfilled');
      expect(results.get('working_"{}"')?.result).toBe('result:working');
      expect(results.get('failing_"{}"')?.status).toBe('rejected');
      expect(results.get('failing_"{}"')?.error?.message).toBe('boom');
    });

    it('should throw immediately when signal is already aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const executor = vi.fn(async () => 'result');
      const plan: ToolExecutionPlan = {
        parallelBatch: [{ name: 'tool', arguments: '{}' }],
        sequentialBatch: [],
        originalOrder: ['tool_"{}"'],
      };

      await expect(executeToolsInParallel(plan, executor, abortController.signal)).rejects.toThrow(
        'Tool execution aborted'
      );
      expect(executor).not.toHaveBeenCalled();
    });

    it('should abort between sequential tools when signal fires', async () => {
      const abortController = new AbortController();
      const executionOrder: string[] = [];

      const executor = vi.fn(async (tool: ToolUseInfo) => {
        executionOrder.push(tool.name);
        if (tool.name === 'write_a') {
          // Abort after first sequential tool completes
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

      // write_a executed, write_b should not have
      expect(executionOrder).toContain('write_a');
      expect(executionOrder).not.toContain('write_b');
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

    it('should handle duplicate tool IDs (same name + args) — last result wins', async () => {
      let callCount = 0;
      const executor = vi.fn(async (tool: ToolUseInfo) => {
        callCount++;
        return `result_${callCount}_${tool.name}`;
      });

      // Two identical tool calls will produce the same key
      const plan: ToolExecutionPlan = {
        parallelBatch: [
          { name: 'file_read', arguments: '{"path": "/a.txt"}' },
          { name: 'file_read', arguments: '{"path": "/a.txt"}' },
        ],
        sequentialBatch: [],
        originalOrder: ['file_read_"{\\"path\\": \\"/a.txt\\"}"', 'file_read_"{\\"path\\": \\"/a.txt\\"}"'],
      };

      const results = await executeToolsInParallel(plan, executor);

      // Both tools executed
      expect(executor).toHaveBeenCalledTimes(2);
      // But only one entry in the Map due to key collision
      expect(results.size).toBe(1);
    });
  });

  describe('getResultsInOrder', () => {
    it('should return results in original order', () => {
      const results = new Map([
        ['tool_c_"{}"', { toolName: 'tool_c', result: 'result_c', status: 'fulfilled' as const }],
        ['tool_a_"{}"', { toolName: 'tool_a', result: 'result_a', status: 'fulfilled' as const }],
        ['tool_b_"{}"', { toolName: 'tool_b', result: 'result_b', status: 'fulfilled' as const }],
      ]);

      const ordered = getResultsInOrder(results, ['tool_a_"{}"', 'tool_b_"{}"', 'tool_c_"{}"']);

      expect(ordered.map(r => r.toolName)).toEqual(['tool_a', 'tool_b', 'tool_c']);
    });

    it('should skip missing results gracefully', () => {
      const results = new Map([
        ['tool_a_"{}"', { toolName: 'tool_a', result: 'result_a', status: 'fulfilled' as const }],
      ]);

      const ordered = getResultsInOrder(results, ['tool_a_"{}"', 'tool_missing_"{}"']);

      expect(ordered).toHaveLength(1);
      expect(ordered[0].toolName).toBe('tool_a');
    });

    it('should handle empty results and empty order', () => {
      expect(getResultsInOrder(new Map(), [])).toEqual([]);
    });

    it('should include rejected results in order', () => {
      const results = new Map([
        ['tool_a_"{}"', { toolName: 'tool_a', result: 'ok', status: 'fulfilled' as const }],
        ['tool_b_"{}"', { toolName: 'tool_b', error: new Error('fail'), status: 'rejected' as const }],
      ]);

      const ordered = getResultsInOrder(results, ['tool_a_"{}"', 'tool_b_"{}"']);

      expect(ordered).toHaveLength(2);
      expect(ordered[0].status).toBe('fulfilled');
      expect(ordered[1].status).toBe('rejected');
    });
  });

  describe('shouldUseParallelExecution', () => {
    it('should return false for empty array', () => {
      expect(shouldUseParallelExecution([])).toBe(false);
    });

    it('should return false for single tool', () => {
      expect(shouldUseParallelExecution([{ name: 'file_read', arguments: '{}' }])).toBe(false);
    });

    it('should return true for 2+ read-only tools', () => {
      const tools: ToolUseInfo[] = [
        { name: 'file_read', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
      ];
      expect(shouldUseParallelExecution(tools)).toBe(true);
    });

    it('should return false for all write tools', () => {
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

    it('should use custom isReadOnly function when provided', () => {
      const tools: ToolUseInfo[] = [
        { name: 'custom_a', arguments: '{}' },
        { name: 'custom_b', arguments: '{}' },
      ];

      // Default: both are read-only (not in write set) -> true
      expect(shouldUseParallelExecution(tools)).toBe(true);

      // Custom: only custom_a is read-only -> 1 read-only -> false
      const customIsReadOnly = (name: string) => name === 'custom_a';
      expect(shouldUseParallelExecution(tools, customIsReadOnly)).toBe(false);
    });
  });

  describe('timing verification', () => {
    it('should complete parallel execution faster than sequential would', async () => {
      const TOOL_DELAY = 50;

      const executor = vi.fn(async () => {
        await new Promise(r => setTimeout(r, TOOL_DELAY));
        return 'result';
      });

      const plan: ToolExecutionPlan = {
        parallelBatch: [
          { name: 'tool_a', arguments: '{}' },
          { name: 'tool_b', arguments: '{}' },
          { name: 'tool_c', arguments: '{}' },
        ],
        sequentialBatch: [],
        originalOrder: ['tool_a_"{}"', 'tool_b_"{}"', 'tool_c_"{}"'],
      };

      const start = Date.now();
      await executeToolsInParallel(plan, executor);
      const duration = Date.now() - start;

      // Sequential would be ~150ms, parallel should be ~50ms
      expect(duration).toBeLessThan(TOOL_DELAY * 2);
    });
  });
});
