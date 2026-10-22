/**
 * Tool-result confidence scoring (`ReActAgent.scoreToolResult`): a tool's own
 * `validateResult` decides its score, with a shape-based default for everything else.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, ICompletionOptionTools, ToolResultValidator } from '@bike4mind/llm-adapters';

function createTool(result: string, validateResult?: ToolResultValidator): ICompletionOptionTools {
  return {
    toolFn: vi.fn(async () => result),
    validateResult,
    toolSchema: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } },
  };
}

/** Calls `probe` once, then answers. */
function createLlm(): ICompletionBackend {
  let callCount = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (_model, _messages, _options, callback) => {
      callCount++;
      await callback([callCount === 1 ? 'Checking' : 'Done'], {
        inputTokens: 10,
        outputTokens: 5,
        toolsUsed: callCount === 1 ? [{ name: 'probe', arguments: '{}' }] : [],
      });
    },
    pushToolMessages: vi.fn(),
  };
}

async function scoreOf(tool: ICompletionOptionTools, logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) {
  const context = {
    userId: 'test-user',
    logger,
    llm: createLlm(),
    model: 'test-model',
    tools: [tool],
    maxIterations: 3,
  } as unknown as AgentContext;
  const agent = new ReActAgent(context);
  await agent.run('probe it');
  const [entry] = agent.toCheckpoint().confidenceLog;
  return { confidence: entry.confidence, source: entry.source };
}

describe('ReActAgent tool-result confidence', () => {
  it('records the score and source a tool validator returns', async () => {
    const tool = createTool('The website is temporarily unavailable.', () => ({
      confidence: 0.1,
      source: 'deterministic',
    }));

    expect(await scoreOf(tool)).toEqual({ confidence: 0.1, source: 'deterministic' });
  });

  it('clamps a validator score into 0-1', async () => {
    const tool = createTool('ok', () => ({ confidence: 4, source: 'heuristic' }));

    expect(await scoreOf(tool)).toEqual({ confidence: 1, source: 'heuristic' });
  });

  it('scores a thrown-tool error 0.1 whatever the validator says', async () => {
    const tool = createTool('Error: provider failed', () => ({ confidence: 0.9, source: 'heuristic' }));

    expect(await scoreOf(tool)).toEqual({ confidence: 0.1, source: 'deterministic' });
  });

  it('falls back to the default when the validator has no opinion', async () => {
    const tool = createTool('a real result', () => undefined);

    expect(await scoreOf(tool)).toEqual({ confidence: 0.7, source: 'default' });
  });

  it('falls back to the default, and logs, when the validator throws', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const tool = createTool('a real result', () => {
      throw new Error('bad validator');
    });

    expect(await scoreOf(tool, logger)).toEqual({ confidence: 0.7, source: 'default' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"probe" threw'), expect.any(Error));
  });

  it('scores an empty result from a tool without a validator as deterministic 0.3', async () => {
    expect(await scoreOf(createTool('   '))).toEqual({ confidence: 0.3, source: 'deterministic' });
  });
});
