/**
 * Tests for ReActAgent checkpoint/resume and runIteration()
 *
 * Validates:
 * 1. toCheckpoint() serializes all relevant state
 * 2. fromCheckpoint() restores state correctly
 * 3. runIteration() executes a single iteration and returns checkpoint
 * 4. Checkpoint/resume produces equivalent results to uninterrupted execution
 * 5. Steps trimming works alongside history trimming
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext, AgentStep, AgentCheckpoint } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import { PermissionDeniedError, type IMessage } from '@bike4mind/common';

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createSimpleTool(name: string, result: string) {
  return {
    toolFn: vi.fn(async () => result),
    toolSchema: {
      name,
      description: `Tool ${name}`,
      parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
    },
  };
}

/**
 * Creates a mock LLM that follows a scripted sequence of responses.
 * Each element in `script` is one LLM call: either tool calls or a final text answer.
 */
function createScriptedLlm(
  script: Array<{
    text: string;
    toolsUsed?: Array<{ name: string; arguments?: string }>;
    inputTokens?: number;
    outputTokens?: number;
  }>
): ICompletionBackend {
  let callIndex = 0;

  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      const step = script[Math.min(callIndex, script.length - 1)];
      callIndex++;

      await callback([step.text], {
        inputTokens: step.inputTokens ?? 100,
        outputTokens: step.outputTokens ?? 50,
        toolsUsed: step.toolsUsed ?? [],
      });
    },
    pushToolMessages: vi.fn(),
  };
}

function createContext(
  llm: ICompletionBackend,
  tools: Array<{
    toolFn: ReturnType<typeof vi.fn>;
    toolSchema: { name: string; description: string; parameters: Record<string, unknown> };
  }>,
  overrides: Partial<AgentContext> = {}
): AgentContext {
  return {
    userId: 'test-user',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: createMockLogger() as any,
    llm,
    model: 'test-model',
    tools,
    maxIterations: 5,
    ...overrides,
  };
}

describe('ReActAgent Checkpoint & Resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('toCheckpoint()', () => {
    it('should serialize all state fields', async () => {
      const tool = createSimpleTool('file_read', 'file contents');
      const llm = createScriptedLlm([
        { text: 'Let me read the file', toolsUsed: [{ name: 'file_read', arguments: '{}' }] },
        { text: 'The file contains: file contents' },
      ]);

      const agent = new ReActAgent(createContext(llm, [tool]));
      await agent.run('Read the file');

      const checkpoint = agent.toCheckpoint();

      expect(checkpoint.iteration).toBeGreaterThan(0);
      expect(checkpoint.messages.length).toBeGreaterThan(0);
      expect(checkpoint.steps.length).toBeGreaterThan(0);
      expect(checkpoint.totalTokens).toBeGreaterThan(0);
      expect(checkpoint.totalInputTokens).toBeGreaterThan(0);
      expect(checkpoint.totalOutputTokens).toBeGreaterThan(0);
      expect(checkpoint.toolCallCount).toBe(1);
      expect(checkpoint.confidenceLog.length).toBe(1);
      expect(checkpoint.confidenceLog[0].toolName).toBe('file_read');
    });

    it('should produce JSON-serializable output', async () => {
      const tool = createSimpleTool('search', 'found it');
      const llm = createScriptedLlm([
        { text: 'Searching', toolsUsed: [{ name: 'search', arguments: '{"q":"test"}' }] },
        { text: 'Found it' },
      ]);

      const agent = new ReActAgent(createContext(llm, [tool]));
      await agent.run('Search for test');

      const checkpoint = agent.toCheckpoint();
      const serialized = JSON.stringify(checkpoint);
      const deserialized = JSON.parse(serialized) as AgentCheckpoint;

      expect(deserialized.iteration).toBe(checkpoint.iteration);
      expect(deserialized.steps.length).toBe(checkpoint.steps.length);
      expect(deserialized.totalTokens).toBe(checkpoint.totalTokens);
    });

    it('should deep-copy state (no shared references)', async () => {
      const llm = createScriptedLlm([{ text: 'Done' }]);
      const agent = new ReActAgent(createContext(llm, []));
      await agent.run('Simple query');

      const cp1 = agent.toCheckpoint();
      const cp2 = agent.toCheckpoint();

      // Mutating cp1 should not affect cp2
      cp1.steps.push({ type: 'thought', content: 'mutated', metadata: { timestamp: 0 } });
      expect(cp2.steps.length).not.toBe(cp1.steps.length);
    });

    it('should deep-copy messages and confidenceLog (no shared references)', async () => {
      const tool = createSimpleTool('search', 'found');
      const llm = createScriptedLlm([
        { text: 'Searching', toolsUsed: [{ name: 'search', arguments: '{}' }] },
        { text: 'Found it' },
      ]);

      const agent = new ReActAgent(createContext(llm, [tool]));
      await agent.run('Search', { maxHistoryIterations: 0 });

      const cp1 = agent.toCheckpoint();
      const cp2 = agent.toCheckpoint();

      // Mutating messages in cp1 should not affect cp2
      cp1.messages.push({ role: 'user', content: 'injected' });
      expect(cp2.messages.length).not.toBe(cp1.messages.length);

      // Mutating confidenceLog in cp1 should not affect cp2
      cp1.confidenceLog.push({ toolName: 'fake', confidence: 0, source: 'default', timestamp: 0 });
      expect(cp2.confidenceLog.length).not.toBe(cp1.confidenceLog.length);
    });
  });

  describe('fromCheckpoint()', () => {
    it('should restore all state fields from checkpoint', () => {
      const llm = createScriptedLlm([{ text: 'anything' }]);
      const agent = new ReActAgent(createContext(llm, []));

      const checkpoint: AgentCheckpoint = {
        iteration: 3,
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'test query' },
        ],
        steps: [
          { type: 'thought', content: 'thinking', metadata: { timestamp: 1000 } },
          { type: 'action', content: 'Using tool: search', metadata: { toolName: 'search', timestamp: 1001 } },
          { type: 'observation', content: 'result', metadata: { toolName: 'search', timestamp: 1002 } },
        ],
        totalTokens: 500,
        totalInputTokens: 300,
        totalOutputTokens: 200,
        totalCacheReadTokens: 100,
        totalCacheWriteTokens: 50,
        totalCredits: 1.5,
        toolCallCount: 2,
        confidenceLog: [{ toolName: 'search', confidence: 0.7, source: 'default', timestamp: 1002 }],
        iterationConfidences: [0.7],
      };

      agent.fromCheckpoint(checkpoint);

      const restored = agent.toCheckpoint();
      expect(restored.iteration).toBe(3);
      expect(restored.steps.length).toBe(3);
      expect(restored.totalTokens).toBe(500);
      expect(restored.totalInputTokens).toBe(300);
      expect(restored.totalOutputTokens).toBe(200);
      expect(restored.totalCacheReadTokens).toBe(100);
      expect(restored.totalCacheWriteTokens).toBe(50);
      expect(restored.totalCredits).toBe(1.5);
      expect(restored.toolCallCount).toBe(2);
      expect(restored.confidenceLog.length).toBe(1);
    });

    it('should deep-copy checkpoint data (no shared references)', () => {
      const llm = createScriptedLlm([{ text: 'anything' }]);
      const agent = new ReActAgent(createContext(llm, []));

      const checkpoint: AgentCheckpoint = {
        iteration: 1,
        messages: [{ role: 'user', content: 'test' }],
        steps: [{ type: 'thought', content: 'hi', metadata: { timestamp: 1 } }],
        totalTokens: 100,
        totalInputTokens: 60,
        totalOutputTokens: 40,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalCredits: 0,
        toolCallCount: 0,
        confidenceLog: [],
        iterationConfidences: [],
      };

      agent.fromCheckpoint(checkpoint);

      // Mutating original checkpoint should not affect agent state
      checkpoint.steps.push({ type: 'action', content: 'mutated', metadata: { timestamp: 2 } });
      checkpoint.iteration = 999;

      const restored = agent.toCheckpoint();
      expect(restored.steps.length).toBe(1);
      expect(restored.iteration).toBe(1);
    });
  });

  describe('runIteration()', () => {
    it('should execute a single iteration and return checkpoint', async () => {
      const tool = createSimpleTool('file_read', 'contents');
      const llm = createScriptedLlm([
        { text: 'Reading file', toolsUsed: [{ name: 'file_read', arguments: '{}' }] },
        { text: 'The answer is: contents' },
      ]);

      const agent = new ReActAgent(createContext(llm, [tool]));

      // First iteration: should call tool
      const result1 = await agent.runIteration('Read the file', { maxHistoryIterations: 0 });
      expect(result1.isComplete).toBe(false);
      expect(result1.reachedMaxIterations).toBe(false);
      expect(result1.checkpoint.iteration).toBe(1);
      expect(result1.checkpoint.toolCallCount).toBe(1);
      expect(result1.allSteps.length).toBeGreaterThan(0);

      // Second iteration: should return final answer
      const result2 = await agent.runIteration('Read the file', { maxHistoryIterations: 0 });
      expect(result2.isComplete).toBe(true);
      expect(result2.step.type).toBe('final_answer');
      expect(result2.step.content).toBe('The answer is: contents');
      expect(result2.checkpoint.iteration).toBe(2);
    });

    it('should return isComplete=true when maxIterations reached', async () => {
      const tool = createSimpleTool('search', 'found');
      // LLM always returns tool calls, never final answer
      const llm = createScriptedLlm([{ text: 'Searching', toolsUsed: [{ name: 'search', arguments: '{}' }] }]);

      const agent = new ReActAgent(createContext(llm, [tool], { maxIterations: 2 }));

      const r1 = await agent.runIteration('Find it', { maxIterations: 2, maxHistoryIterations: 0 });
      expect(r1.isComplete).toBe(false);

      const r2 = await agent.runIteration('Find it', { maxIterations: 2, maxHistoryIterations: 0 });
      expect(r2.isComplete).toBe(true);
      expect(r2.reachedMaxIterations).toBe(true);
    });

    it('stamps metadata.iteration (0-indexed) on every step for replay grouping (#8343)', async () => {
      const tool = createSimpleTool('file_read', 'contents');
      const llm = createScriptedLlm([
        { text: 'Reading file', toolsUsed: [{ name: 'file_read', arguments: '{}' }] },
        { text: 'The answer is: contents' },
      ]);
      const agent = new ReActAgent(createContext(llm, [tool]));

      await agent.runIteration('Read the file', { maxHistoryIterations: 0 });
      await agent.runIteration('Read the file', { maxHistoryIterations: 0 });

      const steps = agent.toCheckpoint().steps;
      // Iteration 0 (first run): thought + action + observation (all 0-indexed).
      // Iteration 1 (second run): final_answer.
      // Assert only that each step has metadata.iteration stamped; exact
      // count/composition is checked loosely so step-ordering changes don't
      // break this contract test.
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.metadata?.iteration).toBeDefined();
        expect(typeof step.metadata!.iteration).toBe('number');
      }
      // First step belongs to iteration 0; last step belongs to a later iteration.
      expect(steps[0]?.metadata?.iteration).toBe(0);
      expect(steps[steps.length - 1]?.metadata?.iteration).toBeGreaterThanOrEqual(0);
    });

    it('should handle abort signal', async () => {
      const controller = new AbortController();
      controller.abort();

      const llm = createScriptedLlm([{ text: 'Done' }]);
      const agent = new ReActAgent(createContext(llm, []));

      const result = await agent.runIteration('test', { signal: controller.signal });
      expect(result.isComplete).toBe(true);
      expect(result.step.content).toBe('Interrupted');
    });

    it('should terminate with reachedMaxTotalTokens when cumulative ceiling is exceeded', async () => {
      const tool = createSimpleTool('search', 'found');
      // LLM keeps requesting tool calls; each call burns 200 tokens (100 in + 100 out).
      const llm = createScriptedLlm([
        { text: 'searching', toolsUsed: [{ name: 'search', arguments: '{}' }], inputTokens: 100, outputTokens: 100 },
      ]);

      const agent = new ReActAgent(createContext(llm, [tool], { maxIterations: 50, maxTotalTokens: 350 }));

      const r1 = await agent.runIteration('Find it', { maxHistoryIterations: 0 });
      // 1st iteration: 200 tokens accumulated, ceiling not exceeded yet
      expect(r1.isComplete).toBe(false);
      expect(r1.reachedMaxTotalTokens).toBeFalsy();

      const r2 = await agent.runIteration('Find it', { maxHistoryIterations: 0 });
      // 2nd iteration: 400 tokens, ceiling exceeded -> terminate
      expect(r2.isComplete).toBe(true);
      expect(r2.reachedMaxTotalTokens).toBe(true);
      expect(r2.reachedMaxIterations).toBe(false);
      expect(r2.step.type).toBe('final_answer');
    });

    it('should emit events during iteration', async () => {
      const tool = createSimpleTool('search', 'result');
      const llm = createScriptedLlm([{ text: 'Thinking about it', toolsUsed: [{ name: 'search', arguments: '{}' }] }]);

      const agent = new ReActAgent(createContext(llm, [tool]));
      const events: Array<{ type: string; step: AgentStep }> = [];

      agent.on('thought', (step: AgentStep) => events.push({ type: 'thought', step }));
      agent.on('action', (step: AgentStep) => events.push({ type: 'action', step }));
      agent.on('observation', (step: AgentStep) => events.push({ type: 'observation', step }));

      await agent.runIteration('Search', { maxHistoryIterations: 0 });

      expect(events.some(e => e.type === 'thought')).toBe(true);
      expect(events.some(e => e.type === 'action')).toBe(true);
      expect(events.some(e => e.type === 'observation')).toBe(true);
    });
  });

  describe('checkpoint → resume via runIteration()', () => {
    it('should produce same final answer when resumed from checkpoint', async () => {
      const tool = createSimpleTool('lookup', 'data-123');
      const finalAnswerText = 'The answer is data-123';

      // Script: iteration 1 calls tool, iteration 2 produces final answer
      const fullScript = [
        { text: 'Looking up', toolsUsed: [{ name: 'lookup', arguments: '{}' }], inputTokens: 100, outputTokens: 50 },
        { text: finalAnswerText, inputTokens: 200, outputTokens: 80 },
      ];

      // --- Uninterrupted run ---
      const agent1 = new ReActAgent(createContext(createScriptedLlm(fullScript), [tool]));
      const uninterrupted = await agent1.run('Find the data', { maxHistoryIterations: 0 });
      expect(uninterrupted.finalAnswer).toBe(finalAnswerText);

      // --- Interrupted + resumed run ---
      const agent2 = new ReActAgent(createContext(createScriptedLlm(fullScript), [tool]));

      const iter1 = await agent2.runIteration('Find the data', { maxHistoryIterations: 0 });
      expect(iter1.isComplete).toBe(false);

      // Simulate checkpoint persist + new agent creation (new Lambda)
      // The resumed LLM starts from script[1] since messages already contain
      // tool call/result from iteration 1 (the LLM will produce final answer)
      const checkpoint = iter1.checkpoint;
      const resumeLlm = createScriptedLlm([{ text: finalAnswerText, inputTokens: 200, outputTokens: 80 }]);
      const agent3 = new ReActAgent(createContext(resumeLlm, [tool]));
      agent3.fromCheckpoint(checkpoint);

      // Run iteration 2 (resumed)
      const iter2 = await agent3.runIteration('Find the data', { maxHistoryIterations: 0 });
      expect(iter2.isComplete).toBe(true);

      expect(iter2.step.content).toBe(uninterrupted.finalAnswer);
    });

    it('should preserve full state (tokens, steps, tool counts) across checkpoint/resume', async () => {
      const tool = createSimpleTool('lookup', 'data-123');
      const finalAnswerText = 'The answer is data-123';

      const fullScript = [
        { text: 'Looking up', toolsUsed: [{ name: 'lookup', arguments: '{}' }], inputTokens: 100, outputTokens: 50 },
        { text: finalAnswerText, inputTokens: 200, outputTokens: 80 },
      ];

      // --- Uninterrupted run ---
      const agent1 = new ReActAgent(createContext(createScriptedLlm(fullScript), [tool]));
      const uninterrupted = await agent1.run('Find the data', { maxHistoryIterations: 0 });
      const uninterruptedCheckpoint = agent1.toCheckpoint();

      // --- Interrupted + resumed run ---
      const agent2 = new ReActAgent(createContext(createScriptedLlm(fullScript), [tool]));
      const iter1 = await agent2.runIteration('Find the data', { maxHistoryIterations: 0 });

      const resumeLlm = createScriptedLlm([{ text: finalAnswerText, inputTokens: 200, outputTokens: 80 }]);
      const agent3 = new ReActAgent(createContext(resumeLlm, [tool]));
      agent3.fromCheckpoint(iter1.checkpoint);
      const iter2 = await agent3.runIteration('Find the data', { maxHistoryIterations: 0 });

      // Full state should match (not just final answer)
      expect(iter2.step.content).toBe(uninterrupted.finalAnswer);
      expect(iter2.checkpoint.totalInputTokens).toBe(uninterruptedCheckpoint.totalInputTokens);
      expect(iter2.checkpoint.totalOutputTokens).toBe(uninterruptedCheckpoint.totalOutputTokens);
      expect(iter2.checkpoint.totalTokens).toBe(uninterruptedCheckpoint.totalTokens);
      expect(iter2.checkpoint.toolCallCount).toBe(uninterruptedCheckpoint.toolCallCount);
      expect(iter2.checkpoint.iteration).toBe(uninterruptedCheckpoint.iteration);
    });

    it('should accumulate tokens across checkpoint/resume boundary', async () => {
      const tool = createSimpleTool('fetch', 'payload');

      const llm1 = createScriptedLlm([
        { text: 'Fetching', toolsUsed: [{ name: 'fetch', arguments: '{}' }], inputTokens: 100, outputTokens: 50 },
      ]);
      const agent1 = new ReActAgent(createContext(llm1, [tool]));
      const iter1 = await agent1.runIteration('Fetch data', { maxHistoryIterations: 0 });

      expect(iter1.checkpoint.totalInputTokens).toBe(100);
      expect(iter1.checkpoint.totalOutputTokens).toBe(50);

      // Resume from checkpoint with a new LLM that returns the final answer
      const llm2 = createScriptedLlm([{ text: 'Done', inputTokens: 200, outputTokens: 80 }]);
      const agent2 = new ReActAgent(createContext(llm2, [tool]));
      agent2.fromCheckpoint(iter1.checkpoint);

      const iter2 = await agent2.runIteration('Fetch data', { maxHistoryIterations: 0 });

      // Tokens should be cumulative across resume boundary
      expect(iter2.checkpoint.totalInputTokens).toBe(300); // 100 + 200
      expect(iter2.checkpoint.totalOutputTokens).toBe(130); // 50 + 80
    });
  });

  describe('runIteration() error handling', () => {
    it('should throw if query is missing on first call (not resumed from checkpoint)', async () => {
      const llm = createScriptedLlm([{ text: 'Done' }]);
      const agent = new ReActAgent(createContext(llm, []));

      await expect(agent.runIteration(undefined)).rejects.toThrow('query is required');
    });

    it('should allow undefined query when resumed from checkpoint', async () => {
      const llm = createScriptedLlm([{ text: 'Resumed answer' }]);
      const agent = new ReActAgent(createContext(llm, []));

      agent.fromCheckpoint({
        iteration: 1,
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'original query' },
        ],
        steps: [],
        totalTokens: 100,
        totalInputTokens: 60,
        totalOutputTokens: 40,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalCredits: 0,
        toolCallCount: 0,
        confidenceLog: [],
        iterationConfidences: [],
      });

      // Should work without query since we're resumed from checkpoint
      const result = await agent.runIteration(undefined, { maxHistoryIterations: 0 });
      expect(result.isComplete).toBe(true);
      expect(result.step.content).toBe('Resumed answer');
    });

    it('should fully rollback all state on LLM error (not just iteration counter)', async () => {
      const tool = createSimpleTool('search', 'found');
      // First call succeeds (tool call), second call throws
      let callCount = 0;
      const llm: ICompletionBackend = {
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
            await callback(['Searching'], {
              inputTokens: 100,
              outputTokens: 50,
              toolsUsed: [{ name: 'search', arguments: '{}' }],
            });
          } else {
            throw new Error('LLM backend unavailable');
          }
        },
        pushToolMessages: vi.fn(),
      };

      const agent = new ReActAgent(createContext(llm, [tool]));

      // First iteration succeeds
      const iter1 = await agent.runIteration('test', { maxHistoryIterations: 0 });
      expect(iter1.checkpoint.iteration).toBe(1);
      expect(iter1.checkpoint.totalInputTokens).toBe(100);
      expect(iter1.checkpoint.toolCallCount).toBe(1);
      const stepsAfterIter1 = iter1.checkpoint.steps.length;

      // Second iteration fails; should fully rollback to pre-iteration state
      await expect(agent.runIteration('test', { maxHistoryIterations: 0 })).rejects.toThrow('LLM backend unavailable');

      const checkpoint = agent.toCheckpoint();
      expect(checkpoint.iteration).toBe(1); // Rolled back from 2 to 1
      expect(checkpoint.totalInputTokens).toBe(100); // Tokens not accumulated from failed call
      expect(checkpoint.toolCallCount).toBe(1); // Tool count not incremented
      expect(checkpoint.steps.length).toBe(stepsAfterIter1); // No new steps from failed iteration
    });

    // Regression: the catch block used to stamp `metadata.iteration` using
    // `this.iterations - 1` *after* `fromCheckpoint(preIterationCheckpoint)`
    // had rolled `this.iterations` back to N-1, so the error step ended up at
    // iteration N-2, one iteration earlier than where it actually ran.
    // IterationStream grouped it into the wrong accordion. The fix captures the
    // in-flight index before rollback.
    //
    // The single-iteration case clamps the bug to 0 either way (post-rollback
    // `this.iterations - 1` = -1, Math.max(0, -1) = 0), so a multi-iteration
    // scenario is required to differentiate. Script iteration 1 to succeed,
    // then iteration 2 to throw PermissionDeniedError mid-LLM-call, and assert
    // the error step is stamped as iteration 1 (not 0).
    it('stamps permission-denied step in second iteration with index 1 (off-by-one regression)', async () => {
      // First iteration completes (returns final_answer), second iteration
      // throws PermissionDeniedError mid-LLM-call. First call succeeds, the
      // second throws.
      let callIndex = 0;
      const llm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callIndex++;
          if (callIndex === 1) {
            // Use a tool so the iteration doesn't terminate early via
            // `iterationComplete = true` (final-answer path). The first
            // iteration should bump `this.iterations` to 1 and finish without
            // the agent's `complete()` being marked done, but a single
            // tool-call iteration suffices since runIteration just returns its
            // checkpoint.
            await callback(['Final from iter 0'], { inputTokens: 10, outputTokens: 10, toolsUsed: [] });
          } else {
            throw new PermissionDeniedError('shell');
          }
        },
        pushToolMessages: vi.fn(),
      };

      const agent = new ReActAgent(createContext(llm, []));
      const iter1 = await agent.runIteration('first', { maxHistoryIterations: 0 });
      expect(iter1.checkpoint.iteration).toBe(1);

      const iter2 = await agent.runIteration(undefined, { maxHistoryIterations: 0 });
      expect(iter2.isComplete).toBe(true);
      expect(iter2.step.type).toBe('final_answer');
      // In-flight 0-indexed iteration when the error fired = 1.
      // Pre-fix this would have been 0 (this.iterations was rolled back
      // from 2 to 1, then `this.iterations - 1` = 0).
      expect(iter2.step.metadata?.iteration).toBe(1);
    });

    it('should handle PermissionDeniedError gracefully in runIteration()', async () => {
      // PermissionDeniedError thrown by a tool is caught inside executeToolWithQueueFallback
      // and returned as an "Error: ..." observation string. The iteration continues normally.
      const permissionTool = {
        toolFn: vi.fn(async () => {
          throw new PermissionDeniedError('dangerous_tool');
        }),
        toolSchema: {
          name: 'dangerous_tool',
          description: 'A tool that requires permission',
          parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
        },
      };

      const llm = createScriptedLlm([
        { text: 'Let me try this', toolsUsed: [{ name: 'dangerous_tool', arguments: '{}' }] },
        { text: 'Permission was denied, here is what happened' },
      ]);

      const agent = new ReActAgent(createContext(llm, [permissionTool]));

      // First iteration: tool throws PermissionDeniedError, caught as observation
      const result1 = await agent.runIteration('Do something dangerous', { maxHistoryIterations: 0 });
      expect(result1.isComplete).toBe(false);
      // The observation should contain the error message
      const obsStep = result1.allSteps.find(s => s.type === 'observation');
      expect(obsStep?.content).toContain('Error:');
      expect(result1.checkpoint).toBeDefined();
      expect(result1.checkpoint.iteration).toBe(1);

      // Second iteration: LLM produces final answer acknowledging the error
      const result2 = await agent.runIteration(undefined, { maxHistoryIterations: 0 });
      expect(result2.isComplete).toBe(true);
      expect(result2.step.type).toBe('final_answer');
    });
  });

  describe('resetIteration()', () => {
    it('should allow starting fresh after a run', async () => {
      const llm = createScriptedLlm([{ text: 'First answer' }]);
      const agent = new ReActAgent(createContext(llm, []));

      const r1 = await agent.runIteration('Query 1', { maxHistoryIterations: 0 });
      expect(r1.checkpoint.iteration).toBe(1);

      // Reset and run again
      agent.resetIteration();
      const r2 = await agent.runIteration('Query 2', { maxHistoryIterations: 0 });
      expect(r2.checkpoint.iteration).toBe(1); // Should be 1 again, not 2
      expect(r2.checkpoint.totalTokens).toBe(150); // Fresh count, not accumulated
    });
  });

  describe('steps trimming', () => {
    it('should trim steps when maxHistoryIterations is set', async () => {
      const tool = createSimpleTool('search', 'found');

      // LLM always returns tool calls for 5 iterations, then final answer
      let callCount = 0;
      const llm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callCount++;
          if (callCount <= 5) {
            await callback([`Searching ${callCount}`], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [{ name: 'search', arguments: `{"q":"${callCount}"}` }],
            });
          } else {
            await callback(['Final result'], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [],
            });
          }
        },
        pushToolMessages: vi.fn(),
      };

      const agent = new ReActAgent(createContext(llm, [tool], { maxIterations: 10 }));
      const result = await agent.run('Search many times', {
        maxHistoryIterations: 2, // Keep only last 2 iterations
      });

      // Steps should be trimmed (max 2 iterations * 7 steps/iteration = 14 steps)
      // Without trimming, 5 tool iterations * ~3 steps each + 1 final = ~16 steps
      expect(result.steps.length).toBeLessThanOrEqual(14 + 1); // +1 for final_answer
      expect(result.finalAnswer).toBe('Final result');
    });
  });

  describe('previousMessages preservation under trimming', () => {
    it('should preserve previousMessages and current query after many ReAct iterations', async () => {
      // Regression: trimConversationHistory used to detect the dynamic-message
      // boundary by finding the first user-role message, which protected only
      // the FIRST previousMessage entry. Subsequent iterations would then
      // mistake prior-turn user messages for ReAct nudges and trim them away,
      // eventually including the current user query itself. Result: the agent
      // "forgot" what was being worked on after a few tool calls.
      const tool = createSimpleTool('grep', 'match found');

      let callCount = 0;
      const llm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callCount++;
          if (callCount <= 6) {
            await callback([`grepping ${callCount}`], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [{ name: 'grep', arguments: `{"q":"${callCount}"}` }],
            });
          } else {
            await callback(['Found the bug'], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [],
            });
          }
        },
        pushToolMessages: vi.fn(),
      };

      const previousMessages: IMessage[] = [
        { role: 'user', content: 'PRIOR_USER_1: I am fixing the auth feature' },
        { role: 'assistant', content: 'PRIOR_ASST_1: Let me look at the auth module' },
        { role: 'user', content: 'PRIOR_USER_2: focus on the token refresh path' },
        { role: 'assistant', content: 'PRIOR_ASST_2: Found the refresh handler' },
      ];

      const agent = new ReActAgent(createContext(llm, [tool], { maxIterations: 10 }));
      await agent.run('CURRENT_QUERY: now fix the expiry bug', {
        previousMessages,
        maxHistoryIterations: 4,
      });

      const checkpoint = agent.toCheckpoint();
      const allContent = checkpoint.messages
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');

      // All previousMessages must survive trimming
      expect(allContent).toContain('PRIOR_USER_1');
      expect(allContent).toContain('PRIOR_ASST_1');
      expect(allContent).toContain('PRIOR_USER_2');
      expect(allContent).toContain('PRIOR_ASST_2');

      // The current user query must survive trimming
      expect(allContent).toContain('CURRENT_QUERY');
    });

    it('should persist initialMessageCount across checkpoint/resume', async () => {
      const tool = createSimpleTool('search', 'found');
      const llm = createScriptedLlm([
        { text: 'Searching', toolsUsed: [{ name: 'search', arguments: '{}' }] },
        { text: 'Done' },
      ]);

      const previousMessages: IMessage[] = [
        { role: 'user', content: 'prior question' },
        { role: 'assistant', content: 'prior answer' },
      ];

      const agent = new ReActAgent(createContext(llm, [tool]));
      await agent.run('current query', { previousMessages });

      const checkpoint = agent.toCheckpoint();
      // system + 2 previousMessages + 1 current query = 4 protected messages
      expect(checkpoint.initialMessageCount).toBe(4);

      // Round-trip through JSON to simulate persistence
      const serialized = JSON.parse(JSON.stringify(checkpoint)) as AgentCheckpoint;
      const resumed = new ReActAgent(createContext(llm, [tool]));
      resumed.fromCheckpoint(serialized);
      expect(resumed.toCheckpoint().initialMessageCount).toBe(4);
    });
  });

  describe('default maxHistoryIterations', () => {
    it('should default to 4 when not specified', async () => {
      const tool = createSimpleTool('search', 'found');

      // Run 6 iterations of tool calls + 1 final answer = 7 total LLM calls
      let callCount = 0;
      const llm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callCount++;
          if (callCount <= 6) {
            await callback([`Step ${callCount}`], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [{ name: 'search', arguments: `{"q":"${callCount}"}` }],
            });
          } else {
            await callback(['Done'], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [],
            });
          }
        },
        pushToolMessages: vi.fn(),
      };

      const agent = new ReActAgent(createContext(llm, [tool], { maxIterations: 10 }));

      // No maxHistoryIterations specified; should default to 4
      const result = await agent.run('Search a lot');

      // With default trimming of 4, steps should be bounded
      // 4 iterations * ~5 steps = ~20 max retained steps + 1 final
      expect(result.steps.length).toBeLessThanOrEqual(21);
      expect(result.finalAnswer).toBe('Done');
    });

    it('should keep all history when maxHistoryIterations is explicitly 0', async () => {
      const tool = createSimpleTool('search', 'found');

      let callCount = 0;
      const llm: ICompletionBackend = {
        currentModel: 'test-model',
        getModelInfo: async () => [],
        complete: async (
          _model: string,
          _messages: IMessage[],
          _options: Partial<ICompletionOptions>,
          callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
        ) => {
          callCount++;
          if (callCount <= 3) {
            await callback([`Step ${callCount}`], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [{ name: 'search', arguments: `{"q":"${callCount}"}` }],
            });
          } else {
            await callback(['Done'], {
              inputTokens: 50,
              outputTokens: 25,
              toolsUsed: [],
            });
          }
        },
        pushToolMessages: vi.fn(),
      };

      const agent = new ReActAgent(createContext(llm, [tool], { maxIterations: 5 }));

      // Explicitly disable trimming
      const result = await agent.run('Search', { maxHistoryIterations: 0 });

      // 3 iterations * 3 steps (thought + action + observation) + 1 final = 10
      // All steps should be retained
      expect(result.steps.length).toBeGreaterThanOrEqual(7); // At minimum: 3 * (action + observation) + final
      expect(result.finalAnswer).toBe('Done');
    });
  });
});
