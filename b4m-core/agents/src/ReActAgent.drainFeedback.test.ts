/**
 * Tests for host feedback drained between iterations
 * (see `AgentRunOptions.drainFeedback`).
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext, AgentStep, FeedbackDrainPhase } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

const TOOL_CALL = Symbol('tool-call');
type ScriptedTurn = typeof TOOL_CALL | string;

function createContext(llm: ICompletionBackend, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    llm,
    model: 'test-model',
    tools: [noopTool],
    maxIterations: 5,
    ...overrides,
  };
}

/** Backend that plays `script` in order (a tool call or a text answer) and snapshots each request's messages. */
function createScriptedLlm(script: ScriptedTurn[]): { llm: ICompletionBackend; callMessages: IMessage[][] } {
  const callMessages: IMessage[][] = [];
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
      const turn = script[callMessages.length - 1];
      if (turn === TOOL_CALL) {
        await callback([''], {
          inputTokens: 5,
          outputTokens: 2,
          toolsUsed: [{ id: `call-${callMessages.length}`, name: 'noop', arguments: '{}' }],
          stopReason: 'tool_use',
        });
        return;
      }
      await callback([turn], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
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

/** A drain that returns each phase's queued values once, then null. */
function createDrain(queued: Partial<Record<FeedbackDrainPhase, string[]>>) {
  return vi.fn(async (phase: FeedbackDrainPhase) => queued[phase]?.shift() ?? null);
}

const lastMessage = (messages: IMessage[]): IMessage => messages[messages.length - 1];

describe('ReActAgent drainFeedback', () => {
  it('folds turn feedback into the tool-results nudge instead of adding a message', async () => {
    const { llm, callMessages } = createScriptedLlm([TOOL_CALL, 'done']);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('edit the file', { drainFeedback: createDrain({ turn: ['src/a.ts:1:1 - error TS2322'] }) });

    const second = callMessages[1];
    expect(second).toHaveLength(callMessages[0].length + 3); // tool_use + tool_result + one nudge
    expect(lastMessage(second).role).toBe('user');
    expect(lastMessage(second).content).toMatch(
      /^Based on the tool results above[\s\S]*\n\nsrc\/a\.ts:1:1 - error TS2322$/
    );
  });

  it('leaves the nudge unchanged when the turn drain is empty', async () => {
    const { llm, callMessages } = createScriptedLlm([TOOL_CALL, 'done']);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('edit the file', { drainFeedback: createDrain({}) });

    expect(lastMessage(callMessages[1]).content).toBe(
      'Based on the tool results above, please provide a complete answer. If I asked for multiple things, make sure to address all of them.'
    );
  });

  it('reopens a final answer when final feedback arrives, demoting it to a thought', async () => {
    const { llm, callMessages } = createScriptedLlm(['draft answer', 'fixed answer']);
    const agent = new ReActAgent(createContext(llm));
    const thoughts: AgentStep[] = [];
    agent.on('thought', step => thoughts.push(step));

    const result = await agent.run('edit the file', {
      drainFeedback: createDrain({ final: ['src/a.ts:1:1 - error TS2322'] }),
    });

    expect(result.finalAnswer).toBe('fixed answer');
    expect(callMessages).toHaveLength(2);
    expect(callMessages[1].slice(-2)).toEqual([
      { role: 'assistant', content: 'draft answer' },
      { role: 'user', content: 'src/a.ts:1:1 - error TS2322' },
    ]);
    expect(thoughts.map(step => step.content)).toEqual(['draft answer']);
    expect(result.steps.filter(step => step.type === 'final_answer').map(step => step.content)).toEqual([
      'fixed answer',
    ]);
  });

  it('does not drain final feedback on the last allowed iteration', async () => {
    const { llm, callMessages } = createScriptedLlm(['only answer']);
    const agent = new ReActAgent(createContext(llm, { maxIterations: 1 }));
    const drain = createDrain({ final: ['late error'] });

    const result = await agent.run('edit the file', { drainFeedback: drain });

    expect(result.finalAnswer).toBe('only answer');
    expect(callMessages).toHaveLength(1);
    expect(drain).not.toHaveBeenCalled();
  });

  it('treats a throwing drain as empty and finishes the run', async () => {
    const { llm } = createScriptedLlm([TOOL_CALL, 'done']);
    const context = createContext(llm);
    const agent = new ReActAgent(context);

    const result = await agent.run('edit the file', {
      drainFeedback: async () => {
        throw new Error('checker crashed');
      },
    });

    expect(result.finalAnswer).toBe('done');
    expect(context.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('drainFeedback(turn) failed'),
      expect.any(Error)
    );
  });

  it('drains both phases in runIteration() as well', async () => {
    const { llm, callMessages } = createScriptedLlm([TOOL_CALL, 'draft answer', 'fixed answer']);
    const agent = new ReActAgent(createContext(llm));
    const options = { drainFeedback: createDrain({ turn: ['turn error'], final: ['final error'] }) };

    let result = await agent.runIteration('edit the file', options);
    while (!result.isComplete) {
      result = await agent.runIteration(undefined, options);
    }

    expect(callMessages).toHaveLength(3);
    expect(String(lastMessage(callMessages[1]).content)).toMatch(/\n\nturn error$/);
    expect(callMessages[2].slice(-2)).toEqual([
      { role: 'assistant', content: 'draft answer' },
      { role: 'user', content: 'final error' },
    ]);
    expect(result.step).toMatchObject({ type: 'final_answer', content: 'fixed answer' });
  });
});
