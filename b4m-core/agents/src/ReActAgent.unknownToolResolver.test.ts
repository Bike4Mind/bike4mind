/**
 * Tests for ReActAgent's unknownToolResolver - used by hosts (e.g. the
 * CLI) that defer rarely-used tool schemas and load them on demand when
 * the model attempts a call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type {
  ICompletionBackend,
  CompletionInfo,
  ICompletionOptionTools,
  ICompletionOptions,
} from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

const makeTool = (name: string): ICompletionOptionTools => ({
  toolFn: vi.fn(async () => `result:${name}`),
  toolSchema: {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
  },
});

/**
 * LLM that calls `firstToolName` once and then returns a final answer.
 * Used to drive a single tool-call -> observation loop.
 */
const makeLlm = (firstToolName: string): ICompletionBackend => {
  let callCount = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
    ) => {
      callCount++;
      if (callCount === 1) {
        await callback(['thinking'], {
          inputTokens: 10,
          outputTokens: 5,
          toolsUsed: [{ name: firstToolName, arguments: '{}' }],
        });
      } else {
        await callback(['done'], { inputTokens: 10, outputTokens: 5, toolsUsed: [] });
      }
    },
    pushToolMessages: vi.fn(),
  };
};

const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never;

describe('ReActAgent unknownToolResolver', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a stop-and-synthesize observation when the tool is missing and no resolver is supplied', async () => {
    const agent = new ReActAgent({
      userId: 'u',
      logger: makeLogger(),
      llm: makeLlm('missing_tool'),
      model: 'test-model',
      tools: [],
    });

    const result = await agent.run('test');
    const observationStep = result.steps.find(s => s.type === 'observation');
    // Must keep the "Error:" prefix so confidence scoring still flags it as a low-confidence
    // error (scoreToolResult/confidenceSource key off startsWith('Error:')), AND carry an
    // explicit stop-retrying instruction - a bare "not found" would loop under a
    // "you MUST call X" prompt.
    expect(observationStep?.content).toMatch(/^Error:/);
    expect(observationStep?.content).toMatch(/Tool "missing_tool" is not available in this context/);
    expect(observationStep?.content).toMatch(/Do NOT attempt to call it again/);
  });

  it('loads the resolved schema into context.tools and returns a retry hint without executing', async () => {
    const deferred = makeTool('deferred_tool');
    const resolver = vi.fn(async (name: string) => (name === 'deferred_tool' ? deferred : null));

    const agent = new ReActAgent({
      userId: 'u',
      logger: makeLogger(),
      llm: makeLlm('deferred_tool'),
      model: 'test-model',
      tools: [],
      unknownToolResolver: resolver,
    });

    const result = await agent.run('test');

    // Resolver was consulted
    expect(resolver).toHaveBeenCalledWith('deferred_tool');

    // Schema got pushed into the live tools array
    const ctxTools = (agent as unknown as { context: { tools: ICompletionOptionTools[] } }).context.tools;
    expect(ctxTools.map(t => t.toolSchema.name)).toContain('deferred_tool');

    // toolFn was NOT executed - the retry hint defers that to the next turn
    expect(deferred.toolFn).not.toHaveBeenCalled();

    // Observation contains the schema and the retry instruction
    const observationStep = result.steps.find(s => s.type === 'observation');
    expect(observationStep?.content).toMatch(/deferred and its schema is now loaded/);
    expect(observationStep?.content).toMatch(/<function>/);
  });

  it('falls through to a stop-and-synthesize observation when the resolver returns null', async () => {
    const resolver = vi.fn(async () => null);

    const agent = new ReActAgent({
      userId: 'u',
      logger: makeLogger(),
      llm: makeLlm('truly_unknown'),
      model: 'test-model',
      tools: [],
      unknownToolResolver: resolver,
    });

    const result = await agent.run('test');
    expect(resolver).toHaveBeenCalledWith('truly_unknown');
    const observationStep = result.steps.find(s => s.type === 'observation');
    expect(observationStep?.content).toMatch(/^Error:/);
    expect(observationStep?.content).toMatch(/Tool "truly_unknown" is not available in this context/);
    expect(observationStep?.content).toMatch(/Do NOT attempt to call it again/);
  });
});
