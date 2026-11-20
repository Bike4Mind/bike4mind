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

/** Calls `probe` with the same arguments `probeCalls` times, one per iteration, then answers. */
function createLlm(probeCalls = 1): ICompletionBackend {
  let callCount = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (_model, _messages, _options, callback) => {
      callCount++;
      const probing = callCount <= probeCalls;
      await callback([probing ? 'Checking' : 'Done'], {
        inputTokens: 10,
        outputTokens: 5,
        toolsUsed: probing ? [{ name: 'probe', arguments: '{}' }] : [],
      });
    },
    pushToolMessages: vi.fn(),
  };
}

async function scoresOf(
  tool: ICompletionOptionTools,
  { probeCalls = 1, logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } } = {}
) {
  const context = {
    userId: 'test-user',
    logger,
    llm: createLlm(probeCalls),
    model: 'test-model',
    tools: [tool],
    maxIterations: probeCalls + 2,
  } as unknown as AgentContext;
  const agent = new ReActAgent(context);
  await agent.run('probe it');
  return agent.toCheckpoint().confidenceLog.map(({ confidence, source }) => ({ confidence, source }));
}

async function scoreOf(
  tool: ICompletionOptionTools,
  logger?: { debug: () => void; info: () => void; warn: () => void }
) {
  const [score] = await scoresOf(tool, logger && { logger });
  return score;
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

  // From the third identical call the agent appends a repeated-call notice to the observation;
  // the validator must still judge exactly what the tool returned.
  it('validates the raw tool output, not the observation carrying the repeated-call notice', async () => {
    const failure = 'The website is temporarily unavailable.';
    const tool = createTool(failure, result =>
      result === failure ? { confidence: 0.1, source: 'deterministic' } : undefined
    );

    const scores = await scoresOf(tool, { probeCalls: 3 });

    expect(scores).toEqual(Array(3).fill({ confidence: 0.1, source: 'deterministic' }));
  });

  it('scores an empty result from a tool without a validator as deterministic 0.3', async () => {
    expect(await scoreOf(createTool('   '))).toEqual({ confidence: 0.3, source: 'deterministic' });
  });

  describe('takeIterationConfidence', () => {
    type Scored = { iterationConfidences: number[]; iterationToolFailed: boolean[] };
    const agentWith = (confidences: number[], failed: boolean[]) => {
      const agent = new ReActAgent({
        userId: 'test-user',
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        llm: createLlm(),
        model: 'test-model',
        tools: [],
      } as unknown as AgentContext);
      Object.assign(agent as unknown as Scored, { iterationConfidences: confidences, iterationToolFailed: failed });
      return agent;
    };

    it('returns the strongest non-failed score and clears the batch', () => {
      const agent = agentWith([0.3, 0.7, 0.9], [false, false, true]);

      expect(agent.takeIterationConfidence()).toBe(0.7);
      expect(agent.takeIterationConfidence()).toBeNull();
    });

    it('returns null and clears the batch when every call failed', () => {
      const agent = agentWith([0.1, 0.1], [true, true]);

      expect(agent.takeIterationConfidence()).toBeNull();
      expect((agent as unknown as Scored).iterationConfidences).toEqual([]);
    });
  });
});
