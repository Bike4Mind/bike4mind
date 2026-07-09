/**
 * Integration tests for ReActAgent parallel tool execution (parallelExecution option).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext, AgentResult, AgentStep } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import { ModelBackend, PermissionDeniedError, type IMessage } from '@bike4mind/common';

// Mock tool that tracks execution timing
function createTimedTool(name: string, delay: number, executionLog: string[]) {
  return {
    toolFn: vi.fn(async () => {
      executionLog.push(`start:${name}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      executionLog.push(`end:${name}`);
      return `result:${name}`;
    }),
    toolSchema: {
      name,
      description: `Test tool ${name}`,
      parameters: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
  };
}

// Create a mock LLM backend that returns specified tool calls
function createMockLlm(
  toolsToCall: Array<{ name: string; arguments?: string }>,
  finalAnswer: string = 'Done'
): ICompletionBackend {
  let callCount = 0;

  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      callCount++;

      if (callCount === 1 && toolsToCall.length > 0) {
        // First call: return tool calls
        await callback(['Thinking...'], {
          inputTokens: 100,
          outputTokens: 50,
          toolsUsed: toolsToCall,
        });
      } else {
        // Second call (or first if no tools): return final answer
        await callback([finalAnswer], {
          inputTokens: 100,
          outputTokens: 50,
          toolsUsed: [],
        });
      }
    },
    pushToolMessages: vi.fn(),
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('ReActAgent Parallel Execution Integration', () => {
  let executionLog: string[];

  beforeEach(() => {
    executionLog = [];
    vi.clearAllMocks();
  });

  describe('parallel execution enabled', () => {
    it('should execute multiple read-only tools in parallel', async () => {
      const TOOL_DELAY = 50;

      const tool1 = createTimedTool('file_read', TOOL_DELAY, executionLog);
      const tool2 = createTimedTool('grep_search', TOOL_DELAY, executionLog);
      const tool3 = createTimedTool('glob_files', TOOL_DELAY, executionLog);

      const mockLlm = createMockLlm([
        { name: 'file_read', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
        { name: 'glob_files', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2, tool3],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      const startTime = Date.now();
      const result = await agent.run('Test query', {
        parallelExecution: true,
      });
      const duration = Date.now() - startTime;

      // All tools should have been called
      expect(tool1.toolFn).toHaveBeenCalledTimes(1);
      expect(tool2.toolFn).toHaveBeenCalledTimes(1);
      expect(tool3.toolFn).toHaveBeenCalledTimes(1);

      // Parallel execution should be faster than sequential
      // Sequential would take ~150ms (3 * 50ms), parallel should be ~50-60ms
      expect(duration).toBeLessThan(TOOL_DELAY * 2.5);

      expect(result.finalAnswer).toBe('Done');
      expect(result.completionInfo.toolCalls).toBe(3);
    });

    it('should emit action events for all tools before execution starts', async () => {
      const actionEvents: AgentStep[] = [];
      const observationEvents: AgentStep[] = [];

      const tool1 = createTimedTool('file_read', 20, executionLog);
      const tool2 = createTimedTool('grep_search', 20, executionLog);

      const mockLlm = createMockLlm([
        { name: 'file_read', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      agent.on('action', (step: AgentStep) => {
        actionEvents.push(step);
      });
      agent.on('observation', (step: AgentStep) => {
        observationEvents.push(step);
      });

      await agent.run('Test query', { parallelExecution: true });

      // Should have 2 action events and 2 observation events
      expect(actionEvents).toHaveLength(2);
      expect(observationEvents).toHaveLength(2);

      // Action events should be for the correct tools
      expect(actionEvents[0].metadata?.toolName).toBe('file_read');
      expect(actionEvents[1].metadata?.toolName).toBe('grep_search');

      // Observation events should contain results
      expect(observationEvents[0].content).toBe('result:file_read');
      expect(observationEvents[1].content).toBe('result:grep_search');
    });

    it('should execute write tools sequentially after read-only tools', async () => {
      const TOOL_DELAY = 30;

      const readTool = createTimedTool('file_read', TOOL_DELAY, executionLog);
      const writeTool1 = createTimedTool('edit_file', TOOL_DELAY, executionLog);
      const writeTool2 = createTimedTool('create_file', TOOL_DELAY, executionLog);

      const mockLlm = createMockLlm([
        { name: 'file_read', arguments: '{}' },
        { name: 'edit_file', arguments: '{}' },
        { name: 'create_file', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [readTool, writeTool1, writeTool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      await agent.run('Test query', { parallelExecution: true });

      // Read tool should complete before write tools start
      const readEndIndex = executionLog.indexOf('end:file_read');
      const write1StartIndex = executionLog.indexOf('start:edit_file');
      const write2StartIndex = executionLog.indexOf('start:create_file');

      expect(readEndIndex).toBeLessThan(write1StartIndex);
      expect(readEndIndex).toBeLessThan(write2StartIndex);

      // Write tools should be sequential (write1 ends before write2 starts)
      const write1EndIndex = executionLog.indexOf('end:edit_file');
      expect(write1EndIndex).toBeLessThan(write2StartIndex);
    });

    it('should use custom isReadOnlyTool function when provided', async () => {
      const tool1 = createTimedTool('custom_read_tool', 20, executionLog);
      const tool2 = createTimedTool('custom_write_tool', 20, executionLog);

      const mockLlm = createMockLlm([
        { name: 'custom_read_tool', arguments: '{}' },
        { name: 'custom_write_tool', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      // Custom function: only 'custom_read_tool' is read-only
      const customIsReadOnly = vi.fn((toolName: string) => toolName === 'custom_read_tool');

      await agent.run('Test query', {
        parallelExecution: true,
        isReadOnlyTool: customIsReadOnly,
      });

      // Custom function should have been called
      expect(customIsReadOnly).toHaveBeenCalledWith('custom_read_tool');
      expect(customIsReadOnly).toHaveBeenCalledWith('custom_write_tool');

      // Read tool should complete before write tool starts
      const readEndIndex = executionLog.indexOf('end:custom_read_tool');
      const writeStartIndex = executionLog.indexOf('start:custom_write_tool');
      expect(readEndIndex).toBeLessThan(writeStartIndex);
    });

    it('should handle tool execution errors without blocking other tools', async () => {
      const successTool = createTimedTool('success_tool', 20, executionLog);
      const failingTool = {
        toolFn: vi.fn(async () => {
          executionLog.push('start:failing_tool');
          throw new Error('Tool execution failed');
        }),
        toolSchema: {
          name: 'failing_tool',
          description: 'A tool that fails',
          parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
        },
      };

      const mockLlm = createMockLlm([
        { name: 'success_tool', arguments: '{}' },
        { name: 'failing_tool', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [successTool, failingTool],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const observationEvents: AgentStep[] = [];

      agent.on('observation', (step: AgentStep) => {
        observationEvents.push(step);
      });

      await agent.run('Test query', { parallelExecution: true });

      // Both tools should have been attempted
      expect(successTool.toolFn).toHaveBeenCalledTimes(1);
      expect(failingTool.toolFn).toHaveBeenCalledTimes(1);

      // Should have observations for both (one success, one error)
      expect(observationEvents).toHaveLength(2);
      expect(observationEvents[0].content).toBe('result:success_tool');
      expect(observationEvents[1].content).toContain('Error: Tool execution failed');
    });
  });

  describe('parallel execution disabled (sequential fallback)', () => {
    it('should execute tools sequentially when parallelExecution is false', async () => {
      const TOOL_DELAY = 30;

      const tool1 = createTimedTool('file_read', TOOL_DELAY, executionLog);
      const tool2 = createTimedTool('grep_search', TOOL_DELAY, executionLog);

      const mockLlm = createMockLlm([
        { name: 'file_read', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      await agent.run('Test query', { parallelExecution: false });

      // Tools should be sequential: tool1 ends before tool2 starts
      const tool1EndIndex = executionLog.indexOf('end:file_read');
      const tool2StartIndex = executionLog.indexOf('start:grep_search');
      expect(tool1EndIndex).toBeLessThan(tool2StartIndex);
    });

    it('should execute tools sequentially when parallelExecution is not specified', async () => {
      const TOOL_DELAY = 30;

      const tool1 = createTimedTool('file_read', TOOL_DELAY, executionLog);
      const tool2 = createTimedTool('grep_search', TOOL_DELAY, executionLog);

      const mockLlm = createMockLlm([
        { name: 'file_read', arguments: '{}' },
        { name: 'grep_search', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      // No parallelExecution option = default to sequential
      await agent.run('Test query');

      // Tools should be sequential
      const tool1EndIndex = executionLog.indexOf('end:file_read');
      const tool2StartIndex = executionLog.indexOf('start:grep_search');
      expect(tool1EndIndex).toBeLessThan(tool2StartIndex);
    });
  });

  describe('edge cases', () => {
    it('should handle single tool without parallel overhead', async () => {
      const tool1 = createTimedTool('file_read', 20, executionLog);

      const mockLlm = createMockLlm([{ name: 'file_read', arguments: '{}' }]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      const result = await agent.run('Test query', { parallelExecution: true });

      expect(tool1.toolFn).toHaveBeenCalledTimes(1);
      expect(result.completionInfo.toolCalls).toBe(1);
    });

    it('should handle all write tools (no parallel execution possible)', async () => {
      const TOOL_DELAY = 20;

      const tool1 = createTimedTool('edit_file', TOOL_DELAY, executionLog);
      const tool2 = createTimedTool('create_file', TOOL_DELAY, executionLog);

      const mockLlm = createMockLlm([
        { name: 'edit_file', arguments: '{}' },
        { name: 'create_file', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      await agent.run('Test query', { parallelExecution: true });

      // All write tools should be sequential even with parallel enabled
      const tool1EndIndex = executionLog.indexOf('end:edit_file');
      const tool2StartIndex = executionLog.indexOf('start:create_file');
      expect(tool1EndIndex).toBeLessThan(tool2StartIndex);
    });

    it('should preserve message order in results regardless of execution order', async () => {
      // Tool 1 is slower than Tool 2, but should appear first in results
      const tool1 = createTimedTool('slow_tool', 50, executionLog);
      const tool2 = createTimedTool('fast_tool', 10, executionLog);

      const mockLlm = createMockLlm([
        { name: 'slow_tool', arguments: '{}' },
        { name: 'fast_tool', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const observationOrder: string[] = [];

      agent.on('observation', (step: AgentStep) => {
        observationOrder.push(step.metadata?.toolName || '');
      });

      await agent.run('Test query', { parallelExecution: true });

      // Observations should be emitted in original order (slow_tool first)
      expect(observationOrder).toEqual(['slow_tool', 'fast_tool']);
    });

    it('should deduplicate identical tool calls (same name + same args)', async () => {
      const tool1 = createTimedTool('file_read', 10, executionLog);

      // LLM returns the same tool call twice with identical name+args
      const mockLlm = createMockLlm([
        { name: 'file_read', arguments: '{}' },
        { name: 'file_read', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const observationEvents: AgentStep[] = [];

      agent.on('observation', (step: AgentStep) => {
        observationEvents.push(step);
      });

      const result = await agent.run('Test query', { parallelExecution: true });

      // Agent deduplicates via processedToolIds - only the first call executes
      expect(result.finalAnswer).toBe('Done');
      expect(tool1.toolFn).toHaveBeenCalledTimes(1);
      expect(observationEvents).toHaveLength(1);
    });
  });

  describe('PermissionDeniedError handling', () => {
    it('should return graceful result when tool throws PermissionDeniedError in parallel path', async () => {
      const readTool = createTimedTool('file_read', 10, executionLog);
      const permTool = {
        toolFn: vi.fn(async () => {
          throw new PermissionDeniedError('dangerous_tool');
        }),
        toolSchema: {
          name: 'dangerous_tool',
          description: 'A tool requiring permission',
          parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
        },
      };

      const mockLlm = createMockLlm([
        { name: 'file_read', arguments: '{}' },
        { name: 'dangerous_tool', arguments: '{}' },
      ]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [readTool, permTool],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);

      // PermissionDeniedError is caught in executeToolWithQueueFallback and
      // returned as an error string, not re-thrown, because the tool execution
      // is wrapped in try/catch. The agent should still produce a result.
      const result = await agent.run('Test query', { parallelExecution: true });

      expect(result.finalAnswer).toBeDefined();
      expect(permTool.toolFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('multi-iteration parallel execution', () => {
    it('should handle parallel tools across multiple LLM iterations', async () => {
      const tool1 = createTimedTool('file_read', 10, executionLog);
      const tool2 = createTimedTool('grep_search', 10, executionLog);

      let callCount = 0;

      const mockLlm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callCount++;

          if (callCount === 1) {
            // Iteration 1: return first batch of tools
            await callback(['Thinking...'], {
              inputTokens: 100,
              outputTokens: 50,
              toolsUsed: [{ name: 'file_read', arguments: '{"path": "/a.txt"}' }],
            });
          } else if (callCount === 2) {
            // Iteration 2: After nudge, return second batch of tools
            await callback(['More thinking...'], {
              inputTokens: 150,
              outputTokens: 75,
              toolsUsed: [
                { name: 'file_read', arguments: '{"path": "/b.txt"}' },
                { name: 'grep_search', arguments: '{"pattern": "test"}' },
              ],
            });
          } else {
            // Iteration 3: return final answer
            await callback(['Final answer'], {
              inputTokens: 200,
              outputTokens: 100,
              toolsUsed: [],
            });
          }
        },
        pushToolMessages: vi.fn(),
      };

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1, tool2],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const result = await agent.run('Test query', { parallelExecution: true });

      expect(result.finalAnswer).toBe('Final answer');
      // 1 tool from iteration 1 + 2 tools from iteration 2
      expect(result.completionInfo.toolCalls).toBe(3);
      expect(result.completionInfo.iterations).toBe(3);
    });
  });

  describe('abort signal handling', () => {
    it('should abort mid-parallel-execution and return Interrupted', async () => {
      const abortController = new AbortController();

      // Tool that aborts while running
      const slowTool = {
        toolFn: vi.fn(async () => {
          // Abort after this tool starts
          abortController.abort();
          await new Promise(r => setTimeout(r, 50));
          return 'result:slow_tool';
        }),
        toolSchema: {
          name: 'slow_tool',
          description: 'Slow tool',
          parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
        },
      };

      const mockLlm = createMockLlm([{ name: 'slow_tool', arguments: '{}' }]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [slowTool],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const result = await agent.run('Test query', {
        parallelExecution: true,
        signal: abortController.signal,
      });

      // Agent should detect abort and return Interrupted
      expect(result.finalAnswer).toBe('Interrupted');
    });

    it('backfills a tool_result for every advertised tool_use when aborted mid-batch', async () => {
      // Regression for #197: a batch cancelled mid-flight must not leave any
      // tool_use without a matching tool_result, or the provider rejects the
      // next turn / session resume with a 400.
      const abortController = new AbortController();

      // Anthropic-shaped tool messages so we can assert tool_use/tool_result
      // pairing and contiguity on the reconstructed history.
      const pushToolMessages = (
        messages: IMessage[],
        tool: { id: string; name: string; parameters: string },
        observation: string
      ) => {
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: {} }] });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tool.id, content: observation }],
        });
      };

      // 2 read-only tools complete, then the 3 write tools are cancelled before
      // they run: read_2 aborts after both reads settle, so the between-phase
      // guard unwinds the batch before the sequential (write) phase.
      const makeTool = (name: string, fn: () => Promise<string>) => ({
        toolFn: vi.fn(fn),
        toolSchema: { name, description: name, parameters: { type: 'object' as const, properties: {}, required: [] } },
      });
      const read1 = makeTool('read_1', async () => 'result:read_1');
      const read2 = makeTool('read_2', async () => {
        abortController.abort();
        return 'result:read_2';
      });
      const write3 = makeTool('write_3', async () => 'result:write_3');
      const write4 = makeTool('write_4', async () => 'result:write_4');
      const write5 = makeTool('write_5', async () => 'result:write_5');

      const toolsUsed = [
        { name: 'read_1', arguments: '{}', id: 'toolu_read_1' },
        { name: 'read_2', arguments: '{}', id: 'toolu_read_2' },
        { name: 'write_3', arguments: '{}', id: 'toolu_write_3' },
        { name: 'write_4', arguments: '{}', id: 'toolu_write_4' },
        { name: 'write_5', arguments: '{}', id: 'toolu_write_5' },
      ];

      const mockLlm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (_model, _messages, _options, callback) => {
          await callback(['Thinking...'], { inputTokens: 100, outputTokens: 50, toolsUsed });
        },
        pushToolMessages: pushToolMessages as unknown as ICompletionBackend['pushToolMessages'],
      };

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [read1, read2, write3, write4, write5],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const result = await agent.run('Test query', {
        parallelExecution: true,
        // Classify write_* as write tools so they land in the sequential phase.
        isReadOnlyTool: (name: string) => name.startsWith('read'),
        signal: abortController.signal,
      });

      expect(result.finalAnswer).toBe('Interrupted');

      // The 3 write tools must never have run (cancelled before execution).
      expect(write3.toolFn).not.toHaveBeenCalled();
      expect(write4.toolFn).not.toHaveBeenCalled();
      expect(write5.toolFn).not.toHaveBeenCalled();

      const messages = agent.toCheckpoint().messages;
      const blocksOf = (content: unknown) =>
        Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
      const toolUseIds = messages.flatMap(m =>
        blocksOf(m.content)
          .filter(b => b.type === 'tool_use')
          .map(b => b.id)
      );
      const toolResultIds = messages.flatMap(m =>
        blocksOf(m.content)
          .filter(b => b.type === 'tool_result')
          .map(b => b.tool_use_id)
      );

      // Parity: every advertised tool_use (all 5) has exactly one matching tool_result.
      expect(toolUseIds.sort()).toEqual(toolsUsed.map(t => t.id).sort());
      expect(toolResultIds.sort()).toEqual(toolUseIds.sort());

      // Contiguity: each tool_use is immediately followed by its own tool_result,
      // with no assistant/user message interleaved.
      for (let i = 0; i < messages.length; i++) {
        const toolUse = blocksOf(messages[i].content).find(b => b.type === 'tool_use');
        if (!toolUse) continue;
        const next = messages[i + 1];
        expect(next?.role).toBe('user');
        const toolResult = blocksOf(next?.content).find(b => b.type === 'tool_result');
        expect(toolResult?.tool_use_id).toBe(toolUse.id);
      }

      // Content: 2 real results, 3 cancelled placeholders.
      const contentById = new Map(
        messages.flatMap(m =>
          blocksOf(m.content)
            .filter(b => b.type === 'tool_result')
            .map(b => [b.tool_use_id as string, b.content as string])
        )
      );
      expect(contentById.get('toolu_read_1')).toBe('result:read_1');
      expect(contentById.get('toolu_read_2')).toBe('result:read_2');
      for (const id of ['toolu_write_3', 'toolu_write_4', 'toolu_write_5']) {
        expect(contentById.get(id)).toMatch(/cancelled before execution/i);
      }
    });
  });

  describe('token and credit tracking', () => {
    it('should accumulate tokens across iterations with parallel execution', async () => {
      const tool1 = createTimedTool('file_read', 5, executionLog);

      let callCount = 0;

      const mockLlm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callCount++;

          if (callCount === 1) {
            await callback(['Thinking...'], {
              inputTokens: 100,
              outputTokens: 50,
              creditsUsed: 0.5,
              toolsUsed: [{ name: 'file_read', arguments: '{}' }],
            });
          } else {
            await callback(['Done'], {
              inputTokens: 200,
              outputTokens: 100,
              creditsUsed: 1.0,
              toolsUsed: [],
            });
          }
        },
        pushToolMessages: vi.fn(),
      };

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const result = await agent.run('Test query', { parallelExecution: true });

      // Tokens should be summed across iterations
      expect(result.completionInfo.totalInputTokens).toBe(300); // 100 + 200
      expect(result.completionInfo.totalOutputTokens).toBe(150); // 50 + 100
      expect(result.completionInfo.totalTokens).toBe(450); // 300 + 150
      expect(result.completionInfo.totalCredits).toBe(1.5); // 0.5 + 1.0
    });

    it('should accumulate cache stats across iterations', async () => {
      const tool1 = createTimedTool('file_read', 5, executionLog);

      let callCount = 0;

      const mockLlm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callCount++;

          if (callCount === 1) {
            // First iteration: cache write (first request populates cache)
            await callback(['Thinking...'], {
              inputTokens: 100,
              outputTokens: 50,
              toolsUsed: [{ name: 'file_read', arguments: '{}' }],
              cacheStats: {
                provider: ModelBackend.Bedrock,
                model: 'test-model',
                totalInputTokens: 7100,
                cacheReadTokens: 0,
                cacheWriteTokens: 7000,
                uncachedTokens: 100,
                cacheHitRate: 0,
                costSavingsPercent: 0,
                estimatedLatencyReduction: 0,
              },
            });
          } else {
            // Second iteration: cache hit (subsequent request reads from cache)
            await callback(['Done'], {
              inputTokens: 200,
              outputTokens: 100,
              toolsUsed: [],
              cacheStats: {
                provider: ModelBackend.Bedrock,
                model: 'test-model',
                totalInputTokens: 180200,
                cacheReadTokens: 180000,
                cacheWriteTokens: 0,
                uncachedTokens: 200,
                cacheHitRate: 99.89,
                costSavingsPercent: 89.9,
                estimatedLatencyReduction: 84.9,
              },
            });
          }
        },
        pushToolMessages: vi.fn(),
      };

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const result = await agent.run('Test query', { parallelExecution: true });

      // Cache stats should be accumulated: 0 + 180000 read, 7000 + 0 write
      expect(result.completionInfo.totalCacheReadTokens).toBe(180000);
      expect(result.completionInfo.totalCacheWriteTokens).toBe(7000);
    });

    it('should omit cache stats when no caching occurred', async () => {
      const mockLlm = createMockLlm([], 'No cache answer');

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      const result = await agent.run('Test query', { parallelExecution: true });

      // When no caching, these should be undefined (omitted when 0)
      expect(result.completionInfo.totalCacheReadTokens).toBeUndefined();
      expect(result.completionInfo.totalCacheWriteTokens).toBeUndefined();
    });
  });

  describe('tool arguments parsing', () => {
    it('should pass parsed arguments to tool functions', async () => {
      const toolFn = vi.fn(async (params: unknown) => {
        return JSON.stringify(params);
      });

      const tool = {
        toolFn,
        toolSchema: {
          name: 'file_read',
          description: 'Read a file',
          parameters: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
            required: ['path'] as string[],
          },
        },
      };

      const mockLlm = createMockLlm([{ name: 'file_read', arguments: '{"path": "/foo/bar.txt"}' }]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      await agent.run('Test query', { parallelExecution: true });

      expect(toolFn).toHaveBeenCalledTimes(1);
      // Arguments should be parsed from JSON string to object
      expect(toolFn).toHaveBeenCalledWith({ path: '/foo/bar.txt' });
    });
  });

  describe('event emission', () => {
    it('should emit thought event when LLM returns text before tool calls', async () => {
      const thoughtEvents: AgentStep[] = [];
      const tool1 = createTimedTool('file_read', 5, executionLog);

      const mockLlm = createMockLlm([{ name: 'file_read', arguments: '{}' }]);

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      agent.on('thought', (step: AgentStep) => {
        thoughtEvents.push(step);
      });

      await agent.run('Test query', { parallelExecution: true });

      // Mock LLM sends 'Thinking...' text before tool calls
      expect(thoughtEvents).toHaveLength(1);
      expect(thoughtEvents[0].type).toBe('thought');
      expect(thoughtEvents[0].content).toBe('Thinking...');
    });

    it('should emit complete event with full result', async () => {
      const completeEvents: AgentResult[] = [];
      const tool1 = createTimedTool('file_read', 5, executionLog);

      const mockLlm = createMockLlm([{ name: 'file_read', arguments: '{}' }], 'All done');

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 5,
      };

      const agent = new ReActAgent(context);
      agent.on('complete', (result: AgentResult) => {
        completeEvents.push(result);
      });

      await agent.run('Test query', { parallelExecution: true });

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].finalAnswer).toBe('All done');
      expect(completeEvents[0].completionInfo.toolCalls).toBe(1);
    });
  });

  describe('maxIterations boundary', () => {
    it('should stop and return partial answer when maxIterations is reached with parallel execution', async () => {
      const tool1 = createTimedTool('file_read', 5, executionLog);

      // LLM always returns tool calls, never a final answer
      const mockLlm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          await callback(['Still working...'], {
            inputTokens: 50,
            outputTokens: 25,
            toolsUsed: [{ name: 'file_read', arguments: '{}' }],
          });
        },
        pushToolMessages: vi.fn(),
      };

      const context: AgentContext = {
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 2,
      };

      const agent = new ReActAgent(context);
      const result = await agent.run('Test query', { parallelExecution: true });

      expect(result.completionInfo.reachedMaxIterations).toBe(true);
      expect(result.completionInfo.iterations).toBe(2);
      // Should use the last text as fallback final answer
      expect(result.finalAnswer).toBeTruthy();
    });
  });

  describe('maxTotalTokens cost backstop', () => {
    it('should stop with reachedMaxTotalTokens when cumulative tokens exceed ceiling', async () => {
      const tool1 = createTimedTool('file_read', 5, []);

      // Each call burns 75 tokens (50 in + 25 out); ceiling 100 trips on 2nd iteration.
      const mockLlm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (_m, _msgs, _opts, callback) => {
          await callback(['Still working...'], {
            inputTokens: 50,
            outputTokens: 25,
            toolsUsed: [{ name: 'file_read', arguments: '{}' }],
          });
        },
        pushToolMessages: vi.fn(),
      };

      const agent = new ReActAgent({
        userId: 'test-user',
        logger: createMockLogger() as any,
        llm: mockLlm,
        model: 'test-model',
        tools: [tool1],
        maxIterations: 50,
        maxTotalTokens: 100,
      });

      const result = await agent.run('Test query');

      expect(result.completionInfo.reachedMaxTotalTokens).toBe(true);
      expect(result.completionInfo.reachedMaxIterations).toBe(false);
      expect(result.completionInfo.iterations).toBeLessThan(50);
      expect(result.finalAnswer).toMatch(/cumulative token ceiling|Still working/);
    });
  });
});
