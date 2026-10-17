import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext, AgentStep } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

// One batch of tool calls on the first turn, then a plain final answer.
function createOneBatchLlm(toolCalls: Array<{ id: string; name: string; arguments?: string }>): ICompletionBackend {
  let turn = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      const first = turn++ === 0;
      await callback([first ? 'working' : 'All done'], {
        inputTokens: 10,
        outputTokens: 5,
        toolsUsed: first ? toolCalls : [],
      });
    },
    pushToolMessages: vi.fn(),
  };
}

const schema = (name: string) => ({
  name,
  description: name,
  parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
});

function createContext(): AgentContext {
  return {
    userId: 'test-user',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AgentContext['logger'],
    llm: createOneBatchLlm([
      { id: 't1', name: 'throws' },
      { id: 't2', name: 'returns_error_text' },
      { id: 't3', name: 'not_registered' },
    ]),
    model: 'test-model',
    tools: [
      {
        toolFn: async () => {
          throw new Error('queue is not linked');
        },
        toolSchema: schema('throws'),
      },
      { toolFn: async () => 'Error: 404 page body fetched successfully', toolSchema: schema('returns_error_text') },
    ],
    maxIterations: 3,
  };
}

const failedByTool = (steps: AgentStep[]) =>
  Object.fromEntries(
    steps.filter(s => s.type === 'observation').map(s => [s.metadata?.toolName, s.metadata?.toolFailed === true])
  );

const expected = { throws: true, returns_error_text: false, not_registered: true };

describe('ReActAgent observation toolFailed flag', () => {
  it.each([false, true])('marks only calls that failed to run (run, parallelExecution=%s)', async parallel => {
    const result = await new ReActAgent(createContext()).run('go', {
      parallelExecution: parallel,
      isReadOnlyTool: () => true,
    });
    expect(failedByTool(result.steps)).toEqual(expected);
  });

  it.each([false, true])('marks only calls that failed to run (runIteration, parallelExecution=%s)', async parallel => {
    const iteration = await new ReActAgent(createContext()).runIteration('go', {
      parallelExecution: parallel,
      isReadOnlyTool: () => true,
    });
    expect(failedByTool(iteration.allSteps)).toEqual(expected);
  });

  // A throw from the deferred-tool resolver escapes the tool-level catch, so the parallel
  // batch reports a rejected result - the path that does not go through `takeToolFailure`.
  it.each([
    ['runIteration', (agent: ReActAgent, options: object) => agent.runIteration('go', options).then(r => r.allSteps)],
    ['run', (agent: ReActAgent, options: object) => agent.run('go', options).then(r => r.steps)],
  ])('marks a rejected parallel result but not a cancelled one (%s)', async (_label, execute) => {
    const context: AgentContext = {
      ...createContext(),
      llm: createOneBatchLlm([
        { id: 'r1', name: 'resolver_fails' },
        { id: 'r2', name: 'resolver_aborts' },
      ]),
      tools: [],
      unknownToolResolver: async name => {
        throw new Error(name === 'resolver_aborts' ? 'The operation was aborted' : 'resolver unavailable');
      },
    };
    const steps = await execute(new ReActAgent(context), { parallelExecution: true, isReadOnlyTool: () => true });
    expect(failedByTool(steps)).toEqual({ resolver_fails: true, resolver_aborts: false });
  });
});
