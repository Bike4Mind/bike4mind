/**
 * Tests for wrapToolWithHooks function
 *
 * Tests the hook wrapper functionality that intercepts tool execution
 * with PreToolUse, PostToolUse, and PostToolUseFailure lifecycle hooks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import {
  wrapToolWithHooks,
  isPathAccessDenial,
  deriveGrantDirectory,
  type HookWrapperContext,
} from './toolsAdapter.js';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { AgentHooks, HookMatcher } from '../agents/types.js';
import { HookBlockedError } from '../agents/types.js';

// Mock the hookExecutor module
vi.mock('../agents/hookExecutor.js', () => ({
  executeHooks: vi.fn(),
  buildHookContext: vi.fn(),
}));

import { executeHooks, buildHookContext } from '../agents/hookExecutor.js';

// Helper to create a mock tool
function createMockTool(name: string, fn?: (args: unknown) => Promise<string>): ICompletionOptionTools {
  return {
    toolFn: fn ?? vi.fn().mockResolvedValue('tool result'),
    toolSchema: {
      name,
      description: `Mock ${name} tool`,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Test input' },
        },
        required: ['input'],
      },
    },
  };
}

// Helper to create a mock hook matcher
function createMockHookMatcher(matcher?: string): HookMatcher[] {
  return [
    {
      matcher,
      hooks: [{ type: 'command', command: 'echo test' }],
    },
  ];
}

// Default hook context for tests
const defaultHookContext: HookWrapperContext = {
  sessionId: 'test-session',
  agentName: 'test-agent',
  cwd: '/test/cwd',
};

describe('wrapToolWithHooks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default mock implementations
    vi.mocked(buildHookContext).mockImplementation(params => ({
      session_id: params.sessionId,
      agent_name: params.agentName,
      cwd: params.cwd,
      hook_event_name: params.hookEventName,
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_result: params.toolResult,
      error: params.error,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('no hooks scenarios', () => {
    it('should return original tool when hooks is undefined', () => {
      const tool = createMockTool('test_tool');

      const wrappedTool = wrapToolWithHooks(tool, undefined, defaultHookContext);

      // Should be the exact same object reference
      expect(wrappedTool).toBe(tool);
    });

    it('should return original tool when only Stop hooks defined (no PreToolUse/PostToolUse/PostToolUseFailure)', () => {
      const tool = createMockTool('test_tool');
      const hooks: AgentHooks = {
        Stop: createMockHookMatcher(),
      };

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      // Should be the exact same object reference (no tool hooks means no wrapping)
      expect(wrappedTool).toBe(tool);
    });

    it('should return original tool when hooks object is empty', () => {
      const tool = createMockTool('test_tool');
      const hooks: AgentHooks = {};

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      expect(wrappedTool).toBe(tool);
    });
  });

  describe('PreToolUse hook scenarios', () => {
    it('should execute tool normally when PreToolUse hook returns allow decision', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      const result = await wrappedTool.toolFn({ input: 'test' });

      expect(result).toBe('tool result');
      expect(originalFn).toHaveBeenCalledWith({ input: 'test' });
      expect(executeHooks).toHaveBeenCalledTimes(1);
      expect(buildHookContext).toHaveBeenCalledWith(
        expect.objectContaining({
          hookEventName: 'PreToolUse',
          toolName: 'test_tool',
          toolInput: { input: 'test' },
        })
      );
    });

    it('should return denial message without executing tool when PreToolUse hook returns deny decision', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({
        decision: 'deny',
        reason: 'Tool is not allowed',
      });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      const result = await wrappedTool.toolFn({ input: 'test' });

      expect(result).toBe('Tool execution denied by hook: Tool is not allowed');
      expect(originalFn).not.toHaveBeenCalled();
    });

    it('should return default denial message when PreToolUse deny has no reason', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'deny' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      const result = await wrappedTool.toolFn({ input: 'test' });

      expect(result).toBe('Tool execution denied by hook: No reason provided');
      expect(originalFn).not.toHaveBeenCalled();
    });

    it('should throw HookBlockedError when PreToolUse hook returns block decision', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({
        decision: 'block',
        reason: 'Critical security violation',
      });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow(HookBlockedError);
      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow(
        'Hook blocked execution of test_tool: Critical security violation'
      );
      expect(originalFn).not.toHaveBeenCalled();
    });

    it('should throw HookBlockedError with default reason when PreToolUse block has no reason', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'block' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow(
        'Hook blocked execution of test_tool: No reason provided'
      );
    });

    it('should modify tool arguments when PreToolUse hook returns updatedInput', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({
        decision: 'allow',
        updatedInput: { input: 'modified value', extra: 'added field' },
      });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      await wrappedTool.toolFn({ input: 'original value' });

      // Original input should be merged with updatedInput
      expect(originalFn).toHaveBeenCalledWith({
        input: 'modified value',
        extra: 'added field',
      });
    });

    it('should preserve original args when updatedInput only adds new fields', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({
        decision: 'allow',
        updatedInput: { newField: 'new value' },
      });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      await wrappedTool.toolFn({ input: 'original' });

      expect(originalFn).toHaveBeenCalledWith({
        input: 'original',
        newField: 'new value',
      });
    });
  });

  describe('PostToolUse hook scenarios', () => {
    it('should return tool result normally when PostToolUse hook returns allow decision', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PostToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      const result = await wrappedTool.toolFn({ input: 'test' });

      expect(result).toBe('tool result');
      expect(executeHooks).toHaveBeenCalledTimes(1);
      expect(buildHookContext).toHaveBeenCalledWith(
        expect.objectContaining({
          hookEventName: 'PostToolUse',
          toolName: 'test_tool',
          toolInput: { input: 'test' },
          toolResult: 'tool result',
        })
      );
    });

    it('should throw HookBlockedError when PostToolUse hook returns block decision', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PostToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({
        decision: 'block',
        reason: 'Output validation failed',
      });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      // Tool executes but hook blocks after
      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow(HookBlockedError);
      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow(
        'Hook blocked execution of test_tool: Output validation failed'
      );
      // Original tool should have executed
      expect(originalFn).toHaveBeenCalled();
    });

    it('should pass tool result to PostToolUse hook context', async () => {
      const tool = createMockTool('test_tool', async () => 'specific tool output');
      const hooks: AgentHooks = {
        PostToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      await wrappedTool.toolFn({ input: 'test' });

      expect(buildHookContext).toHaveBeenCalledWith(
        expect.objectContaining({
          toolResult: 'specific tool output',
        })
      );
    });
  });

  describe('PostToolUseFailure hook scenarios', () => {
    it('should execute PostToolUseFailure hook when tool throws an error', async () => {
      const toolError = new Error('Tool execution failed');
      const originalFn = vi.fn().mockRejectedValue(toolError);
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PostToolUseFailure: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow('Tool execution failed');

      expect(executeHooks).toHaveBeenCalledTimes(1);
      expect(buildHookContext).toHaveBeenCalledWith(
        expect.objectContaining({
          hookEventName: 'PostToolUseFailure',
          toolName: 'test_tool',
          toolInput: { input: 'test' },
          error: 'Tool execution failed',
        })
      );
    });

    it('should re-throw original error after PostToolUseFailure hook executes', async () => {
      const toolError = new Error('Original error message');
      const originalFn = vi.fn().mockRejectedValue(toolError);
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PostToolUseFailure: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow(toolError);
      // Ensure it's the exact same error object
      try {
        await wrappedTool.toolFn({ input: 'test' });
      } catch (e) {
        expect(e).toBe(toolError);
      }
    });

    it('should not execute PostToolUseFailure hook when tool succeeds', async () => {
      const originalFn = vi.fn().mockResolvedValue('success');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PostToolUseFailure: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      await wrappedTool.toolFn({ input: 'test' });

      // executeHooks should not be called since tool succeeded
      expect(executeHooks).not.toHaveBeenCalled();
    });
  });

  describe('combined hook scenarios', () => {
    it('should execute PreToolUse and PostToolUse hooks in sequence on success', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
        PostToolUse: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      await wrappedTool.toolFn({ input: 'test' });

      expect(executeHooks).toHaveBeenCalledTimes(2);

      // Verify order of calls
      const calls = vi.mocked(buildHookContext).mock.calls;
      expect(calls[0][0].hookEventName).toBe('PreToolUse');
      expect(calls[1][0].hookEventName).toBe('PostToolUse');
    });

    it('should execute PreToolUse and PostToolUseFailure hooks when tool fails', async () => {
      const toolError = new Error('Tool failed');
      const originalFn = vi.fn().mockRejectedValue(toolError);
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
        PostToolUseFailure: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      await expect(wrappedTool.toolFn({ input: 'test' })).rejects.toThrow('Tool failed');

      expect(executeHooks).toHaveBeenCalledTimes(2);

      const calls = vi.mocked(buildHookContext).mock.calls;
      expect(calls[0][0].hookEventName).toBe('PreToolUse');
      expect(calls[1][0].hookEventName).toBe('PostToolUseFailure');
    });

    it('should not execute PostToolUse or PostToolUseFailure when PreToolUse denies', async () => {
      const originalFn = vi.fn().mockResolvedValue('tool result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
        PostToolUse: createMockHookMatcher('test_tool'),
        PostToolUseFailure: createMockHookMatcher('test_tool'),
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'deny', reason: 'Denied' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      await wrappedTool.toolFn({ input: 'test' });

      // Only PreToolUse should be called
      expect(executeHooks).toHaveBeenCalledTimes(1);
      expect(buildHookContext).toHaveBeenCalledWith(expect.objectContaining({ hookEventName: 'PreToolUse' }));
    });

    it('should pass modified args from PreToolUse to PostToolUse', async () => {
      const originalFn = vi.fn().mockResolvedValue('result');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
        PostToolUse: createMockHookMatcher('test_tool'),
      };

      // First call (PreToolUse) returns modified input
      // Second call (PostToolUse) returns allow
      vi.mocked(executeHooks)
        .mockResolvedValueOnce({ decision: 'allow', updatedInput: { modified: true } })
        .mockResolvedValueOnce({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);
      await wrappedTool.toolFn({ original: true });

      // PostToolUse should receive the modified args
      const postToolUseCall = vi.mocked(buildHookContext).mock.calls[1];
      expect(postToolUseCall[0].toolInput).toEqual({ original: true, modified: true });
    });
  });

  describe('tool schema preservation', () => {
    it('should preserve tool schema in wrapped tool', () => {
      const tool = createMockTool('preserved_tool');
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('preserved_tool'),
      };

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      expect(wrappedTool.toolSchema).toEqual(tool.toolSchema);
      expect(wrappedTool.toolSchema.name).toBe('preserved_tool');
      expect(wrappedTool.toolSchema.description).toBe('Mock preserved_tool tool');
    });

    it('should not modify original tool object', () => {
      const originalFn = vi.fn().mockResolvedValue('original');
      const tool = createMockTool('test_tool', originalFn);
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('test_tool'),
      };

      const wrappedTool = wrapToolWithHooks(tool, hooks, defaultHookContext);

      // Original tool should be unchanged
      expect(tool.toolFn).toBe(originalFn);
      // Wrapped tool should have different function
      expect(wrappedTool.toolFn).not.toBe(originalFn);
    });
  });

  describe('hook context building', () => {
    it('should pass correct context to buildHookContext', async () => {
      const tool = createMockTool('context_test');
      const hooks: AgentHooks = {
        PreToolUse: createMockHookMatcher('context_test'),
      };
      const customContext: HookWrapperContext = {
        sessionId: 'custom-session-123',
        agentName: 'custom-agent',
        cwd: '/custom/working/dir',
      };

      vi.mocked(executeHooks).mockResolvedValue({ decision: 'allow' });

      const wrappedTool = wrapToolWithHooks(tool, hooks, customContext);
      await wrappedTool.toolFn({ param: 'value' });

      expect(buildHookContext).toHaveBeenCalledWith({
        sessionId: 'custom-session-123',
        agentName: 'custom-agent',
        cwd: '/custom/working/dir',
        hookEventName: 'PreToolUse',
        toolName: 'context_test',
        toolInput: { param: 'value' },
      });
    });
  });
});

describe('isPathAccessDenial', () => {
  it('detects the file-tool allow-list denial (returned as a string)', () => {
    expect(
      isPathAccessDenial(
        'Error reading file: Access denied: Cannot read files outside allowed directories. Working directory: /a'
      )
    ).toBe(true);
  });

  it('detects denials for each file operation verb', () => {
    for (const op of ['read', 'create', 'edit', 'delete', 'access']) {
      expect(isPathAccessDenial(`Access denied: Cannot ${op} files outside allowed directories.`)).toBe(true);
    }
  });

  it('detects the grep_search path-validation denial (thrown)', () => {
    expect(
      isPathAccessDenial(
        'Path validation failed: "/elsewhere" resolves outside allowed directories. Working directory: /a'
      )
    ).toBe(true);
  });

  it("detects the glob_files denial, which omits the word 'files'", () => {
    // core glob_files throws `Access denied: Cannot search outside allowed directories.`
    expect(isPathAccessDenial('Access denied: Cannot search outside allowed directories. Working directory: /a')).toBe(
      true
    );
  });

  it('does not flag ordinary tool output or unrelated errors', () => {
    expect(isPathAccessDenial('Error reading file: ENOENT: no such file or directory')).toBe(false);
    expect(isPathAccessDenial('Found 3 matches in 2 files')).toBe(false);
    expect(isPathAccessDenial('')).toBe(false);
  });
});

describe('deriveGrantDirectory', () => {
  it('grants the parent directory for file-targeting tools', () => {
    const abs = path.join(path.parse(process.cwd()).root, 'somewhere', 'proj', 'file.ts');
    expect(deriveGrantDirectory('file_read', { path: abs })).toBe(path.dirname(abs));
    expect(deriveGrantDirectory('create_file', { path: abs })).toBe(path.dirname(abs));
    expect(deriveGrantDirectory('edit_local_file', { path: abs })).toBe(path.dirname(abs));
    expect(deriveGrantDirectory('delete_file', { path: abs })).toBe(path.dirname(abs));
  });

  it('grants the directory itself for grep_search / glob_files', () => {
    const dir = path.join(path.parse(process.cwd()).root, 'somewhere', 'proj');
    expect(deriveGrantDirectory('grep_search', { dir_path: dir })).toBe(dir);
    expect(deriveGrantDirectory('glob_files', { dir_path: dir })).toBe(dir);
  });

  it('resolves relative paths against the current working directory', () => {
    expect(deriveGrantDirectory('grep_search', { dir_path: 'sub/dir' })).toBe(path.resolve(process.cwd(), 'sub/dir'));
    expect(deriveGrantDirectory('file_read', { path: 'sub/file.ts' })).toBe(
      path.dirname(path.resolve(process.cwd(), 'sub/file.ts'))
    );
  });

  it('returns null when no usable path argument is present', () => {
    expect(deriveGrantDirectory('file_read', {})).toBeNull();
    expect(deriveGrantDirectory('grep_search', { dir_path: '' })).toBeNull();
    expect(deriveGrantDirectory('file_read', { path: 123 as unknown as string })).toBeNull();
  });
});
