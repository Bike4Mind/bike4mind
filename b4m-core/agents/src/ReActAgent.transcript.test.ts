/**
 * The transcript owner, end to end through ReActAgent: every request is repaired before it is sent,
 * and within a run each request is a byte prefix of the next, so provider prompt caching holds.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent, WORKFLOW_REMINDER_MARKER } from './ReActAgent';
import type { AgentContext } from './types';
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
});
