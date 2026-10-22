/**
 * The transcript owner, end to end through ReActAgent: every request is repaired before it is sent,
 * and within a run each request is a byte prefix of the next, so provider prompt caching holds.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent, WORKFLOW_REMINDER_MARKER } from './ReActAgent';
import type { AgentCheckpoint, AgentContext, RunIterationOptions } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

type ToolUse = { id?: string; name: string; arguments: string };

/**
 * Backend that answers with `responses[i]` tool calls on its i-th completion (then a final answer)
 * and records each request exactly as serialized at call time. `pushToolMessages` appends real
 * Anthropic-style tool_use/tool_result pairs, the shape the CLI backends use.
 */
function createRecordingLlm(responses: ToolUse[][]) {
  const requests: string[] = [];
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
      requests.push(JSON.stringify(messages));
      const toolsUsed = responses[callIndex++];
      if (toolsUsed) {
        await callback([''], { inputTokens: 5, outputTokens: 2, toolsUsed, stopReason: 'tool_use' });
        return;
      }
      await callback(['final answer'], { inputTokens: 5, outputTokens: 2, toolsUsed: [], stopReason: 'end_turn' });
    },
    pushToolMessages: (messages, tool, observation) => {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.parameters || '{}') }],
      });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: observation }] });
    },
  };
  return { llm, requests: () => requests.map(request => JSON.parse(request) as IMessage[]) };
}

const readTool = {
  toolFn: async (args: unknown) => `read ${JSON.stringify(args)}`,
  toolSchema: {
    name: 'read',
    description: 'read a file',
    parameters: { type: 'object' as const, properties: { path: { type: 'string' } } },
  },
};

function createContext(llm: ICompletionBackend, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    llm,
    model: 'test-model',
    tools: [readTool],
    maxIterations: 10,
    ...overrides,
  };
}

const isReminder = (message: IMessage) =>
  typeof message.content === 'string' && message.content.startsWith(WORKFLOW_REMINDER_MARKER);

/** The part of a request a provider can cache: everything before the trailing workflow reminder. */
function cacheablePrefix(request: IMessage[]): IMessage[] {
  return request.length > 0 && isReminder(request[request.length - 1]) ? request.slice(0, -1) : request;
}

const toolResults = (request: IMessage[]) =>
  request.flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []
  );

describe('ReActAgent transcript owner', () => {
  it('sends each request as a byte prefix of the next within a run', async () => {
    const { llm, requests } = createRecordingLlm([
      [{ id: 'call-1', name: 'read', arguments: '{"path": "a.ts"}' }],
      [
        { id: 'call-2', name: 'read', arguments: '{"path": "b.ts"}' },
        { id: 'call-3', name: 'read', arguments: '{"path": "c.ts"}' },
      ],
      [{ id: 'call-4', name: 'read', arguments: '{"path": "d.ts"}' }],
    ]);
    const agent = new ReActAgent(createContext(llm));
    let version = 0;

    const result = await agent.run('read the files', {
      previousMessages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
      workflowReminder: () => `todos v${++version}`,
      // History trimming deliberately rewrites the prefix to bound context; it is the one known
      // break, so keep it out of this run.
      maxHistoryIterations: 0,
    });

    expect(result.finalAnswer).toBe('final answer');
    const sent = requests();
    expect(sent).toHaveLength(4);
    for (let k = 0; k + 1 < sent.length; k++) {
      const prefix = JSON.stringify(cacheablePrefix(sent[k]));
      const next = JSON.stringify(sent[k + 1].slice(0, cacheablePrefix(sent[k]).length));
      expect(next).toBe(prefix);
    }
  });

  it('records a call with malformed arguments as {} instead of failing the turn', async () => {
    const { llm, requests } = createRecordingLlm([
      [
        { id: 'call-1', name: 'read', arguments: '{"path": "a.ts"}' },
        { id: 'call-2', name: 'read', arguments: '{"path": ' },
      ],
    ]);
    const agent = new ReActAgent(createContext(llm));

    const result = await agent.run('read the files');

    expect(result.finalAnswer).toBe('final answer');
    const last = requests()[1];
    const calls = last.flatMap(message =>
      Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use') : []
    );
    expect(calls.map(call => call.input)).toEqual([{ path: 'a.ts' }, {}]);
    expect(toolResults(last).map(block => block.tool_use_id)).toEqual(['call-1', 'call-2']);
  });

  it('runs and records two identical calls that carry different ids', async () => {
    const { llm, requests } = createRecordingLlm([
      [
        { id: 'call-1', name: 'read', arguments: '{"path": "a.ts"}' },
        { id: 'call-2', name: 'read', arguments: '{"path": "a.ts"}' },
      ],
    ]);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('read it twice');

    expect(toolResults(requests()[1]).map(block => block.tool_use_id)).toEqual(['call-1', 'call-2']);
  });

  it('answers a call left unanswered in the history before sending it', async () => {
    const { llm, requests } = createRecordingLlm([]);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('continue', {
      previousMessages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'stale', name: 'read', input: {} }] },
      ],
    });

    const [first] = requests();
    expect(toolResults(first)).toEqual([
      { type: 'tool_result', tool_use_id: 'stale', content: 'Tool call did not return a result.' },
    ]);
    const callIndex = first.findIndex(
      message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use')
    );
    expect(toolResults([first[callIndex + 1]])).toHaveLength(1);
  });

  it('keeps the current query when a repair inside the history shifts its position', async () => {
    const rounds = Array.from({ length: 7 }, (_, i) => [
      { id: `call-${i}`, name: 'read', arguments: `{"path": "${i}.ts"}` },
    ]);
    const { llm, requests } = createRecordingLlm(rounds);
    const agent = new ReActAgent(createContext(llm));

    await agent.run('THE QUERY', {
      previousMessages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'stale', name: 'read', input: {} }] },
      ],
    });

    const sent = requests();
    expect(sent).toHaveLength(8);
    for (const request of sent) {
      expect(request.some(message => message.content === 'THE QUERY')).toBe(true);
    }
  });

  it('hands reactive compaction the protected prefix length after repair', async () => {
    const { llm } = createRecordingLlm([]);
    const complete = llm.complete;
    let failed = false;
    llm.complete = async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error('prompt is too long: context window exceeded');
      }
      return complete(...args);
    };
    const onContextLimit = vi.fn(async () => null);
    const agent = new ReActAgent(createContext(llm));

    await agent
      .run('continue', {
        previousMessages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'stale', name: 'read', input: {} }] },
        ],
        onContextLimit,
      })
      .catch(() => undefined);

    // system + stale call + its synthesized result + query
    expect(onContextLimit).toHaveBeenCalledWith(expect.any(Array), 4);
  });

  it('sends the history as is when the backend cannot build a result', async () => {
    const { llm, requests } = createRecordingLlm([]);
    llm.pushToolMessages = () => {
      throw new Error('tools not supported');
    };
    const agent = new ReActAgent(createContext(llm));

    const result = await agent.run('continue', {
      previousMessages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'stale', name: 'read', input: {} }] }],
    });

    expect(result.finalAnswer).toBe('final answer');
    expect(toolResults(requests()[0])).toEqual([]);
  });

  describe('runIteration()', () => {
    const staleCall: IMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'stale', name: 'read', input: {} }],
    };
    const checkpointWith = (messages: IMessage[]): AgentCheckpoint => ({
      iteration: 0,
      messages,
      steps: [],
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCredits: 0,
      toolCallCount: 0,
      confidenceLog: [],
      iterationConfidences: [],
      initialMessageCount: messages.length,
    });
    async function runToCompletion(agent: ReActAgent, query?: string, options: RunIterationOptions = {}) {
      let result = await agent.runIteration(query, options);
      while (!result.isComplete) result = await agent.runIteration(undefined, options);
      return result;
    }

    it('answers a dangling call in a resumed checkpoint before the request', async () => {
      const { llm, requests } = createRecordingLlm([]);
      const agent = new ReActAgent(createContext(llm));
      agent.fromCheckpoint(
        checkpointWith([{ role: 'system', content: 'system' }, staleCall, { role: 'user', content: 'continue' }])
      );

      await runToCompletion(agent);

      const [first] = requests();
      expect(first[2]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'stale', content: 'Tool call did not return a result.' }],
      });
      expect(toolResults(first)).toHaveLength(1);
    });

    it('computes the protected prefix after repairing the history', async () => {
      const { llm } = createRecordingLlm([]);
      const agent = new ReActAgent(createContext(llm));

      const result = await agent.runIteration('continue', { previousMessages: [staleCall] });

      // system + stale call + its synthesized result + query
      expect(result.checkpoint.initialMessageCount).toBe(4);
    });

    it('keeps the query protected when a resumed checkpoint is repaired inside its prefix', async () => {
      const rounds = Array.from({ length: 7 }, (_, i) => [
        { id: `call-${i}`, name: 'read', arguments: `{"path": "${i}.ts"}` },
      ]);
      const { llm, requests } = createRecordingLlm(rounds);
      const agent = new ReActAgent(createContext(llm));
      agent.fromCheckpoint(
        checkpointWith([{ role: 'system', content: 'system' }, staleCall, { role: 'user', content: 'THE QUERY' }])
      );

      const result = await runToCompletion(agent);

      expect(result.checkpoint.initialMessageCount).toBe(4);
      const sent = requests();
      expect(sent).toHaveLength(8);
      for (const request of sent) {
        expect(request.some(message => message.content === 'THE QUERY')).toBe(true);
      }
    });
  });

  it('gives identical parallel calls with different ids their own results', async () => {
    let runs = 0;
    const countingTool = { ...readTool, toolFn: async () => `run ${++runs}` };
    const { llm, requests } = createRecordingLlm([
      [
        { id: 'call-1', name: 'read', arguments: '{"path": "a.ts"}' },
        { id: 'call-2', name: 'read', arguments: '{"path": "a.ts"}' },
      ],
    ]);
    const agent = new ReActAgent(createContext(llm, { tools: [countingTool] }));

    await agent.run('read it twice', { parallelExecution: true, isReadOnlyTool: () => true });

    const contents = toolResults(requests()[1]).map(block => block.content);
    expect(new Set(contents)).toEqual(new Set(['run 1', 'run 2']));
  });
});
