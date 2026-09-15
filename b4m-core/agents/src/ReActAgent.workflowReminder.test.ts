/**
 * Tests for per-iteration live workflow state re-injection
 * (see `AgentRunOptions.workflowReminder`).
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent, WORKFLOW_REMINDER_MARKER } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createContext(llm: ICompletionBackend, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: createMockLogger() as any,
    llm,
    model: 'test-model',
    tools: [],
    maxIterations: 5,
    ...overrides,
  };
}

function countReminders(messages: IMessage[]): number {
  return messages.filter(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(WORKFLOW_REMINDER_MARKER)
  ).length;
}

/**
 * Backend that requests a tool call on the first N completions (so the loop
 * keeps iterating), then finishes with a final answer. Snapshots the message
 * list it was called with on every completion.
 */
function createToolThenAnswerLlm(toolIterations: number): {
  llm: ICompletionBackend;
  callMessages: IMessage[][];
} {
  const callMessages: IMessage[][] = [];
  let callIndex = 0;
  const llm: ICompletionBackend = {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      callMessages.push(messages.map(m => ({ ...m })));
      callIndex++;
      if (callIndex <= toolIterations) {
        await callback([''], {
          inputTokens: 5,
          outputTokens: 2,
          toolsUsed: [{ id: `call-${callIndex}`, name: 'noop', arguments: '{}' }],
          stopReason: 'tool_use',
        });
        return;
      }
      await callback(['final answer'], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
    },
    pushToolMessages: (messages, toolCall, observation) => {
      messages.push({ role: 'assistant', content: `[tool_use ${toolCall.id}]` } as IMessage);
      messages.push({ role: 'user', content: `[tool_result ${toolCall.id}] ${observation}` } as IMessage);
    },
  };
  return { llm, callMessages };
}

const noopTool = {
  toolFn: async () => 'ok',
  toolSchema: { name: 'noop', description: 'noop', parameters: { type: 'object' as const, properties: {} } },
};

describe('ReActAgent workflow reminder injection', () => {
  it('appends the reminder as the last message of every LLM request', async () => {
    const { llm, callMessages } = createToolThenAnswerLlm(2);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    const result = await agent.run('do the thing', {
      workflowReminder: () => 'Open todos:\n1. [in_progress] fix the bug',
    });

    expect(result.finalAnswer).toBe('final answer');
    expect(callMessages.length).toBe(3);
    for (const messages of callMessages) {
      const last = messages[messages.length - 1];
      expect(last.role).toBe('user');
      expect(last.content).toBe(`${WORKFLOW_REMINDER_MARKER}\nOpen todos:\n1. [in_progress] fix the bug`);
    }
  });

  it('replaces the reminder across iterations instead of stacking', async () => {
    const { llm, callMessages } = createToolThenAnswerLlm(3);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    let version = 0;
    await agent.run('do the thing', {
      workflowReminder: () => `state v${++version}`,
    });

    expect(callMessages.length).toBe(4);
    for (const messages of callMessages) {
      expect(countReminders(messages)).toBe(1);
    }
    // Each request carries the freshly-rendered state, not a stale copy.
    const lastRequest = callMessages[callMessages.length - 1];
    expect(lastRequest[lastRequest.length - 1].content).toBe(`${WORKFLOW_REMINDER_MARKER}\nstate v4`);
  });

  it('omits the reminder for iterations where the provider returns null or empty', async () => {
    const { llm, callMessages } = createToolThenAnswerLlm(2);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    const returns: Array<string | null> = ['todos: 1 open', null, '   '];
    let i = 0;
    await agent.run('do the thing', {
      workflowReminder: () => returns[i++] ?? null,
    });

    expect(countReminders(callMessages[0])).toBe(1);
    // Later iterations with empty state carry no reminder at all - the stale
    // one from iteration 1 must have been removed, not left behind.
    expect(countReminders(callMessages[1])).toBe(0);
    expect(countReminders(callMessages[2])).toBe(0);
  });

  it('behaves exactly as before when the option is not provided', async () => {
    const { llm, callMessages } = createToolThenAnswerLlm(1);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    const result = await agent.run('do the thing');

    expect(result.finalAnswer).toBe('final answer');
    for (const messages of callMessages) {
      expect(countReminders(messages)).toBe(0);
    }
  });

  it('does not confuse history trimming: reminder is removed before the trim heuristic runs', async () => {
    // 4 tool iterations with maxHistoryIterations=2 forces trimming; the
    // reminder must survive as exactly one tail message on every request and
    // the run must still terminate normally.
    const { llm, callMessages } = createToolThenAnswerLlm(4);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    const result = await agent.run('do the thing', {
      maxHistoryIterations: 2,
      workflowReminder: () => 'persistent state',
    });

    expect(result.finalAnswer).toBe('final answer');
    for (const messages of callMessages) {
      expect(countReminders(messages)).toBe(1);
      expect(messages[messages.length - 1].content).toBe(`${WORKFLOW_REMINDER_MARKER}\npersistent state`);
    }
  });

  it('injects and replaces the reminder in runIteration() as well', async () => {
    const { llm, callMessages } = createToolThenAnswerLlm(2);
    const agent = new ReActAgent(createContext(llm, { tools: [noopTool] }));

    let version = 0;
    const options = { workflowReminder: () => `iter state v${++version}` };

    let result = await agent.runIteration('do the thing', options);
    while (!result.isComplete) {
      result = await agent.runIteration(undefined, options);
    }

    expect(callMessages.length).toBe(3);
    for (const messages of callMessages) {
      expect(countReminders(messages)).toBe(1);
      const last = messages[messages.length - 1];
      expect(String(last.content).startsWith(WORKFLOW_REMINDER_MARKER)).toBe(true);
    }
    const lastRequest = callMessages[2];
    expect(lastRequest[lastRequest.length - 1].content).toBe(`${WORKFLOW_REMINDER_MARKER}\niter state v3`);
  });
});
