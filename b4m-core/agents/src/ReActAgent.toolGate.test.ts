/**
 * Pre-execution permission gate: `AgentRunOptions.toolGate` must withhold a tool
 * call BEFORE `toolFn` runs, so a call the user has not approved never reaches its
 * provider (and never bills one). Approval replays it via `executeGatedToolCall`.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import { GATED_TOOL_OBSERVATION, type AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import { ModelBackend, type IMessage } from '@bike4mind/common';

function createTool(name: string, calls: string[]) {
  return {
    toolFn: vi.fn(async () => {
      calls.push(name);
      return `result:${name}`;
    }),
    toolSchema: { name, description: name, parameters: { type: 'object' as const, properties: {}, required: [] } },
  };
}

function createMockLlm(toolsToCall: Array<{ name: string; arguments?: string; id?: string }>): ICompletionBackend {
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
      await callback([callCount === 1 ? 'Working...' : 'All done'], {
        inputTokens: 10,
        outputTokens: 5,
        toolsUsed: callCount === 1 ? toolsToCall : [],
      });
    },
    pushToolMessages: (messages, toolCall, observation) => {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: toolCall.id, name: toolCall.name }] });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: observation }],
      });
    },
    replaceLastToolResultObservation: (messages, toolCallId, newObservation) => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const content = messages[i].content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = block as { type?: string; tool_use_id?: string; content?: string };
          if (b.type === 'tool_result' && b.tool_use_id === toolCallId) {
            b.content = newObservation;
            return;
          }
        }
      }
      throw new Error(`no tool_result for ${toolCallId}`);
    },
  } as unknown as ICompletionBackend;
}

function buildContext(tools: ReturnType<typeof createTool>[], llm: ICompletionBackend): AgentContext {
  return {
    llm,
    model: 'test-model',
    modelBackend: ModelBackend.Anthropic,
    tools,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AgentContext;
}

describe('ReActAgent pre-execution tool gate', () => {
  it('does not invoke a withheld tool and reports it on the iteration result', async () => {
    const calls: string[] = [];
    const tool = createTool('image_generation', calls);
    const agent = new ReActAgent(
      buildContext([tool], createMockLlm([{ name: 'image_generation', arguments: '{"prompt":"cat"}', id: 'toolu_1' }]))
    );

    const result = await agent.runIteration('draw a cat', { toolGate: () => true });

    expect(tool.toolFn).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(result.gatedToolCalls).toEqual([
      { id: 'toolu_1', name: 'image_generation', input: '{"prompt":"cat"}' },
    ]);
  });

  it('pairs the withheld tool_use with a placeholder tool_result so the checkpoint stays valid', async () => {
    const agent = new ReActAgent(
      buildContext(
        [createTool('image_generation', [])],
        createMockLlm([{ name: 'image_generation', arguments: '{}', id: 'toolu_1' }])
      )
    );

    const result = await agent.runIteration('draw a cat', { toolGate: () => true });

    const resultBlocks = result.checkpoint.messages.flatMap(m =>
      Array.isArray(m.content) ? (m.content as Array<{ type?: string; tool_use_id?: string; content?: string }>) : []
    );
    expect(resultBlocks.find(b => b.tool_use_id === 'toolu_1')?.content).toBe(GATED_TOOL_OBSERVATION);
  });

  it('runs the tools the gate allows and withholds only the rest', async () => {
    const calls: string[] = [];
    const safe = createTool('web_search', calls);
    const gated = createTool('send_slack_message', calls);
    const agent = new ReActAgent(
      buildContext(
        [safe, gated],
        createMockLlm([
          { name: 'web_search', arguments: '{}', id: 'toolu_1' },
          { name: 'send_slack_message', arguments: '{}', id: 'toolu_2' },
        ])
      )
    );

    const result = await agent.runIteration('look and tell', {
      toolGate: call => call.name === 'send_slack_message',
    });

    expect(calls).toEqual(['web_search']);
    expect(result.gatedToolCalls?.map(c => c.name)).toEqual(['send_slack_message']);
  });

  it('runs every tool when no gate is supplied', async () => {
    const calls: string[] = [];
    const tool = createTool('image_generation', calls);
    const agent = new ReActAgent(
      buildContext([tool], createMockLlm([{ name: 'image_generation', arguments: '{}', id: 'toolu_1' }]))
    );

    const result = await agent.runIteration('draw a cat');

    expect(calls).toEqual(['image_generation']);
    expect(result.gatedToolCalls).toBeUndefined();
  });

  it('executeGatedToolCall runs the tool and swaps the placeholder for the real observation', async () => {
    const calls: string[] = [];
    const tool = createTool('image_generation', calls);
    const agent = new ReActAgent(
      buildContext([tool], createMockLlm([{ name: 'image_generation', arguments: '{}', id: 'toolu_1' }]))
    );

    const gatedResult = await agent.runIteration('draw a cat', { toolGate: () => true });
    const observation = await agent.executeGatedToolCall(gatedResult.gatedToolCalls![0]);

    expect(observation).toBe('result:image_generation');
    expect(calls).toEqual(['image_generation']);

    const checkpoint = agent.toCheckpoint();
    const resultBlocks = checkpoint.messages.flatMap(m =>
      Array.isArray(m.content) ? (m.content as Array<{ tool_use_id?: string; content?: string }>) : []
    );
    expect(resultBlocks.find(b => b.tool_use_id === 'toolu_1')?.content).toBe('result:image_generation');
    expect(checkpoint.steps.at(-1)).toMatchObject({ type: 'observation', content: 'result:image_generation' });
  });

  it('refuses to replay before running the tool when the backend cannot record the result', async () => {
    const calls: string[] = [];
    const tool = createTool('image_generation', calls);
    const llm = createMockLlm([{ name: 'image_generation', arguments: '{}', id: 'toolu_1' }]);
    delete (llm as { replaceLastToolResultObservation?: unknown }).replaceLastToolResultObservation;
    const agent = new ReActAgent(buildContext([tool], llm));

    const gatedResult = await agent.runIteration('draw a cat', { toolGate: () => true });

    await expect(agent.executeGatedToolCall(gatedResult.gatedToolCalls![0])).rejects.toThrow(/cannot record/);
    // The point of the check: the side effect must not have landed.
    expect(calls).toEqual([]);
  });
});
