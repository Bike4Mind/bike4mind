/**
 * Tests the hook execution system that runs shell commands or LLM prompts
 * at agent lifecycle events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildHookContext, executeHooks, type HookContext } from './hookExecutor.js';
import type { HookMatcher } from './types.js';
import type { ShellRunnerResult } from '../utils/shellRunner.js';

// Mock shellRunner
vi.mock('../utils/shellRunner.js', () => ({
  runShellCommand: vi.fn(),
}));

import { runShellCommand } from '../utils/shellRunner.js';

const mockRunShellCommand = vi.mocked(runShellCommand);

function shellResult(overrides: Partial<ShellRunnerResult> = {}): ShellRunnerResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides };
}

describe('hookExecutor', () => {
  describe('buildHookContext', () => {
    it('should transform camelCase parameters to snake_case correctly', () => {
      const result = buildHookContext({
        sessionId: 'session-123',
        agentName: 'test-agent',
        cwd: '/path/to/project',
        hookEventName: 'PreToolUse',
      });

      expect(result).toEqual({
        session_id: 'session-123',
        agent_name: 'test-agent',
        cwd: '/path/to/project',
        hook_event_name: 'PreToolUse',
        tool_name: undefined,
        tool_input: undefined,
        tool_use_id: undefined,
        tool_result: undefined,
        error: undefined,
      });
    });

    it('should include optional toolName field when provided', () => {
      const result = buildHookContext({
        sessionId: 'session-123',
        agentName: 'test-agent',
        cwd: '/path/to/project',
        hookEventName: 'PreToolUse',
        toolName: 'Bash',
      });

      expect(result.tool_name).toBe('Bash');
    });

    it('should include optional toolInput field when provided', () => {
      const toolInput = { command: 'ls -la', timeout: 30000 };
      const result = buildHookContext({
        sessionId: 'session-123',
        agentName: 'test-agent',
        cwd: '/path/to/project',
        hookEventName: 'PreToolUse',
        toolInput,
      });

      expect(result.tool_input).toEqual(toolInput);
    });

    it('should include optional toolUseId field when provided', () => {
      const result = buildHookContext({
        sessionId: 'session-123',
        agentName: 'test-agent',
        cwd: '/path/to/project',
        hookEventName: 'PreToolUse',
        toolUseId: 'tool-use-456',
      });

      expect(result.tool_use_id).toBe('tool-use-456');
    });

    it('should include optional toolResult field when provided', () => {
      const result = buildHookContext({
        sessionId: 'session-123',
        agentName: 'test-agent',
        cwd: '/path/to/project',
        hookEventName: 'PostToolUse',
        toolResult: 'Command executed successfully',
      });

      expect(result.tool_result).toBe('Command executed successfully');
    });

    it('should include optional error field when provided', () => {
      const result = buildHookContext({
        sessionId: 'session-123',
        agentName: 'test-agent',
        cwd: '/path/to/project',
        hookEventName: 'PostToolUseFailure',
        error: 'Command failed with exit code 1',
      });

      expect(result.error).toBe('Command failed with exit code 1');
    });

    it('should properly map all fields when all parameters are provided', () => {
      const toolInput = { command: 'npm test', timeout: 60000 };
      const result = buildHookContext({
        sessionId: 'session-abc',
        agentName: 'code-reviewer',
        cwd: '/workspace/myproject',
        hookEventName: 'PostToolUse',
        toolName: 'Bash',
        toolInput,
        toolUseId: 'tool-789',
        toolResult: 'Tests passed',
        error: undefined,
      });

      expect(result).toEqual({
        session_id: 'session-abc',
        agent_name: 'code-reviewer',
        cwd: '/workspace/myproject',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: toolInput,
        tool_use_id: 'tool-789',
        tool_result: 'Tests passed',
        error: undefined,
      });
    });

    it('should leave optional fields as undefined when not provided', () => {
      const result = buildHookContext({
        sessionId: 'session-123',
        agentName: 'test-agent',
        cwd: '/path/to/project',
        hookEventName: 'Stop',
      });

      expect(result.tool_name).toBeUndefined();
      expect(result.tool_input).toBeUndefined();
      expect(result.tool_use_id).toBeUndefined();
      expect(result.tool_result).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe('executeHooks', () => {
    const baseContext: HookContext = {
      session_id: 'session-123',
      agent_name: 'test-agent',
      cwd: '/path/to/project',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return { decision: "allow" } when hooks array is undefined', async () => {
      const result = await executeHooks(undefined, baseContext);
      expect(result).toEqual({ decision: 'allow' });
    });

    it('should return { decision: "allow" } when hooks array is empty', async () => {
      const result = await executeHooks([], baseContext);
      expect(result).toEqual({ decision: 'allow' });
    });

    it('should return { decision: "allow" } when no matchers match the tool name', async () => {
      const hooks: HookMatcher[] = [
        {
          matcher: 'Edit',
          hooks: [{ type: 'command', command: 'echo "deny"' }],
        },
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'echo "block"' }],
        },
      ];

      const result = await executeHooks(hooks, baseContext);
      // No matchers match "Bash", so no hooks are executed
      expect(result).toEqual({ decision: 'allow' });
    });

    describe('with mocked shellRunner', () => {
      it('should return deny result when hook exits with code 2', async () => {
        mockRunShellCommand.mockResolvedValue(shellResult({ exitCode: 2, stderr: 'Operation not allowed' }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'exit 2' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({
          decision: 'deny',
          reason: 'Operation not allowed',
        });
      });

      it('should use default reason when hook exits with code 2 and no stderr', async () => {
        mockRunShellCommand.mockResolvedValue(shellResult({ exitCode: 2, stderr: '' }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'exit 2' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({
          decision: 'deny',
          reason: 'Hook blocked execution',
        });
      });

      it('should return allow with parsed JSON when hook exits with code 0', async () => {
        const jsonOutput = JSON.stringify({ decision: 'allow', updatedInput: { validated: true } });
        mockRunShellCommand.mockResolvedValue(shellResult({ stdout: jsonOutput }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo json' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('allow');
        expect(result.updatedInput).toEqual({ validated: true });
      });

      it('should return block decision when hook returns block in JSON', async () => {
        const jsonOutput = JSON.stringify({ decision: 'block', reason: 'Critical error detected' });
        mockRunShellCommand.mockResolvedValue(shellResult({ stdout: jsonOutput }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo json' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({ decision: 'block', reason: 'Critical error detected' });
      });

      it('should stop at first deny decision', async () => {
        const denyJson = JSON.stringify({ decision: 'deny', reason: 'First hook denied' });
        const allowJson = JSON.stringify({ decision: 'allow' });

        let callCount = 0;
        mockRunShellCommand.mockImplementation(async () => {
          callCount++;
          const output = callCount === 1 ? denyJson : allowJson;
          return shellResult({ stdout: output });
        });

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'hook1' },
              { type: 'command', command: 'hook2' },
            ],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        // First deny should win
        expect(result.decision).toBe('deny');
        expect(result.reason).toBe('First hook denied');
      });

      it('should stop at first block decision', async () => {
        const blockJson = JSON.stringify({ decision: 'block', reason: 'Critical block' });
        const allowJson = JSON.stringify({ decision: 'allow' });

        let callCount = 0;
        mockRunShellCommand.mockImplementation(async () => {
          callCount++;
          const output = callCount === 1 ? blockJson : allowJson;
          return shellResult({ stdout: output });
        });

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'hook1' },
              { type: 'command', command: 'hook2' },
            ],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('block');
        expect(result.reason).toBe('Critical block');
      });

      it('should merge updatedInput from multiple hooks that return allow', async () => {
        const hook1Output = JSON.stringify({
          decision: 'allow',
          updatedInput: { timeout: 30000, sanitized: true },
        });
        const hook2Output = JSON.stringify({
          decision: 'allow',
          updatedInput: { validated: true, sanitized: false },
        });

        let callCount = 0;
        mockRunShellCommand.mockImplementation(async () => {
          callCount++;
          const output = callCount === 1 ? hook1Output : hook2Output;
          return shellResult({ stdout: output });
        });

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'hook1' },
              { type: 'command', command: 'hook2' },
            ],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('allow');
        // Later hooks should override earlier ones for same keys
        expect(result.updatedInput).toEqual({
          timeout: 30000,
          sanitized: false, // Overwritten by hook2
          validated: true, // Added by hook2
        });
      });

      it('should handle hooks without command (return allow)', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command' }], // No command specified
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({ decision: 'allow' });
      });

      it('should allow when hook exits with non-zero, non-2 code', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockRunShellCommand.mockResolvedValue(shellResult({ exitCode: 1, stderr: 'Some error' }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'exit 1' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({ decision: 'allow' });
        expect(consoleSpy).toHaveBeenCalledWith('Hook exited with code 1: Some error');
        consoleSpy.mockRestore();
      });

      it('should allow when hook outputs invalid JSON', async () => {
        mockRunShellCommand.mockResolvedValue(shellResult({ stdout: 'not valid json' }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo invalid' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({ decision: 'allow' });
      });

      it('should default to allow when JSON has no decision field', async () => {
        const jsonOutput = JSON.stringify({ reason: 'Some info', extra: 'data' });
        mockRunShellCommand.mockResolvedValue(shellResult({ stdout: jsonOutput }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo json' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('allow');
      });
    });

    describe('matcher regex patterns', () => {
      beforeEach(() => {
        const denyJson = JSON.stringify({ decision: 'deny', reason: 'matched' });
        mockRunShellCommand.mockResolvedValue(shellResult({ stdout: denyJson }));
      });

      it('should match exact tool name', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        const result = await executeHooks(hooks, { ...baseContext, tool_name: 'Bash' });
        expect(result.decision).toBe('deny'); // Hook matched and denied
      });

      it('should not match different tool name with exact matcher', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        const result = await executeHooks(hooks, { ...baseContext, tool_name: 'Bash' });
        expect(result.decision).toBe('allow'); // No hook matched
      });

      it('should match wildcard patterns like "bash_.*"', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'bash_.*',
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        const result = await executeHooks(hooks, { ...baseContext, tool_name: 'bash_execute' });
        expect(result.decision).toBe('deny'); // Hook matched
      });

      it('should match OR patterns like "Edit|Write"', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        const resultEdit = await executeHooks(hooks, { ...baseContext, tool_name: 'Edit' });
        expect(resultEdit.decision).toBe('deny');

        const resultWrite = await executeHooks(hooks, { ...baseContext, tool_name: 'Write' });
        expect(resultWrite.decision).toBe('deny');

        // For Bash, no hook should match, so no runShellCommand call
        mockRunShellCommand.mockClear();
        const resultBash = await executeHooks(hooks, { ...baseContext, tool_name: 'Bash' });
        expect(resultBash.decision).toBe('allow'); // No match
        expect(mockRunShellCommand).not.toHaveBeenCalled();
      });

      it('should match complex regex patterns', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'mcp__[a-z]+__.*',
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        const result = await executeHooks(hooks, { ...baseContext, tool_name: 'mcp__github__create_issue' });
        expect(result.decision).toBe('deny');

        const resultNoMatch = await executeHooks(hooks, { ...baseContext, tool_name: 'mcp__UPPER__method' });
        expect(resultNoMatch.decision).toBe('allow'); // [a-z]+ doesn't match UPPER
      });

      it('should execute hooks when no matcher is specified (e.g., Stop event)', async () => {
        const hooks: HookMatcher[] = [
          {
            // No matcher - matches everything
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('deny');
      });

      it('should execute hooks when tool_name is not provided in context', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        const contextWithoutTool: HookContext = {
          ...baseContext,
          tool_name: undefined,
        };

        const result = await executeHooks(hooks, contextWithoutTool);
        // When tool_name is undefined, shouldMatch logic returns true
        expect(result.decision).toBe('deny');
      });

      it('should handle invalid regex patterns gracefully (no match)', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: '[invalid(regex', // Invalid regex
            hooks: [{ type: 'command', command: 'test' }],
          },
        ];

        // Should not throw, should just not match
        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('allow');
      });
    });

    describe('hook error handling', () => {
      it('should allow on execution error', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockRunShellCommand.mockResolvedValue(shellResult({ exitCode: null, stderr: 'spawn ENOENT' }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'nonexistent-command' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({ decision: 'allow' });
        expect(consoleSpy).toHaveBeenCalledWith('Hook execution error: spawn ENOENT');
        consoleSpy.mockRestore();
      });

      it('should deny on timeout (fail-closed)', async () => {
        mockRunShellCommand.mockResolvedValue(shellResult({ timedOut: true, exitCode: null }));

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'sleep 999' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('timed out');
      });
    });

    describe('multiple hook matchers', () => {
      it('should aggregate hooks from multiple matching matchers', async () => {
        mockRunShellCommand.mockImplementation(async options => {
          const isHook1 = options.command.includes('hook1');
          const output = JSON.stringify({
            decision: 'allow',
            updatedInput: isHook1 ? { key1: 'value1' } : { key2: 'value2' },
          });
          return shellResult({ stdout: output });
        });

        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'hook1' }],
          },
          {
            matcher: 'Bash|Edit',
            hooks: [{ type: 'command', command: 'hook2' }],
          },
        ];

        const result = await executeHooks(hooks, baseContext);
        expect(result.decision).toBe('allow');
        // Both matchers match, so both hooks run and inputs are merged
        expect(result.updatedInput).toEqual({
          key1: 'value1',
          key2: 'value2',
        });
      });
    });

    describe('prompt hooks (future feature)', () => {
      it('should skip prompt type hooks (only command hooks supported)', async () => {
        const hooks: HookMatcher[] = [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'prompt', prompt: 'Evaluate this action' }, // Should be skipped
            ],
          },
        ];

        // No runShellCommand should be called for prompt hooks
        const result = await executeHooks(hooks, baseContext);
        expect(result).toEqual({ decision: 'allow' });
        expect(mockRunShellCommand).not.toHaveBeenCalled();
      });
    });
  });
});
