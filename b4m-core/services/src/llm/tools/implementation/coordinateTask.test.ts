import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReActAgent } from '@bike4mind/agents';
import { resolveDeprecatedModelId, type ICompletionBackend } from '@bike4mind/llm-adapters';
import { getTextModelCost, type ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { usdToCredits } from '@bike4mind/utils';
import { ServerAgentStore } from '../../agents/ServerAgentStore';
import {
  ServerSubagentOrchestrator,
  type ServerAgentExecutionResult,
} from '../../agents/ServerSubagentOrchestrator';
import { createCoordinateTaskTool, type DagDispatcher } from './coordinateTask';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
  } as unknown as Logger;
}

function makeLlm(): ICompletionBackend {
  return {
    currentModel: 'claude-sonnet-4-6',
    complete: vi.fn(),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  } as unknown as ICompletionBackend;
}

function makeDagDispatcher(): DagDispatcher {
  return {
    createNode: vi.fn(),
    dispatchNode: vi.fn(),
  };
}

describe('createCoordinateTaskTool \u2014 per-member credit cap gate', () => {
  it('refuses to spawn the coordinator when checkMemberCreditCap returns true, spending no LLM tokens', async () => {
    const llm = makeLlm();

    const tool = createCoordinateTaskTool({
      userId: 'u1',
      llm,
      logger: makeLogger(),
      parentTools: [],
      agentStore: new ServerAgentStore({}),
      dagDispatcher: makeDagDispatcher(),
      getParentExecutionId: () => 'exec-1',
      checkMemberCreditCap: () => true,
    });

    const result = await tool.toolFn({ task: 'Decompose this into research + writing subtasks' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/credit limit reached/);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

describe('createCoordinateTaskTool \u2014 coordinator spend billing', () => {
  const MODEL_ID = 'claude-sonnet-4-6';
  const model: ModelInfo = {
    id: MODEL_ID,
    backend: 'bedrock',
    pricing: { 1_000_000: { input: 0.000003, output: 0.000015 } },
  } as unknown as ModelInfo;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeResult(overrides: Partial<ServerAgentExecutionResult> = {}): ServerAgentExecutionResult {
    return {
      agentName: 'coordinator',
      thoroughness: 'medium',
      summary: 'done',
      finalAnswer: 'done',
      model: MODEL_ID,
      steps: [],
      completionInfo: {
        totalTokens: 15_000,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        totalCredits: 50,
        iterations: 2,
        toolCalls: 1,
        reachedMaxIterations: false,
      },
      ...overrides,
    } as ServerAgentExecutionResult;
  }

  function makeTool(overrides: Partial<Parameters<typeof createCoordinateTaskTool>[0]> = {}) {
    const onCredits = vi.fn();
    const tool = createCoordinateTaskTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: new ServerAgentStore({}),
      dagDispatcher: makeDagDispatcher(),
      getParentExecutionId: () => 'exec-1',
      availableModels: [model],
      onCredits,
      ...overrides,
    });
    return { tool, onCredits };
  }

  it('bills the coordinator run through onCredits when its tracker does not', async () => {
    vi.spyOn(ServerSubagentOrchestrator.prototype, 'delegateToAgent').mockResolvedValue(makeResult());
    const { tool, onCredits } = makeTool();

    await tool.toolFn({ task: 'Decompose this' });

    expect(onCredits).toHaveBeenCalledTimes(1);
    expect(onCredits).toHaveBeenCalledWith(50, expect.objectContaining({ model: MODEL_ID, inputTokens: 12_000 }));
  });

  it('does not report a coordinator run its tracker already billed', async () => {
    vi.spyOn(ServerSubagentOrchestrator.prototype, 'delegateToAgent').mockResolvedValue(
      makeResult({ billedByTracker: true })
    );
    const { tool, onCredits } = makeTool();

    await tool.toolFn({ task: 'Decompose this' });

    expect(onCredits).not.toHaveBeenCalled();
  });

  it('bills what a failed coordinator spent before it threw, then returns its error', async () => {
    vi.spyOn(ReActAgent.prototype, 'run').mockRejectedValue(new Error('provider 500'));
    vi.spyOn(ReActAgent.prototype, 'toCheckpoint').mockReturnValue({
      totalTokens: 15_000,
      totalInputTokens: 12_000,
      totalOutputTokens: 3_000,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      turnUsage: [],
      totalCredits: 0,
    } as unknown as ReturnType<ReActAgent['toCheckpoint']>);
    // The coordinator runs on its own configured model; the catalog row must match it.
    const coordinatorModel = resolveDeprecatedModelId(
      new ServerAgentStore({}).getAgent('coordinator')!.model!,
      'test'
    );
    const priced = { ...model, id: coordinatorModel };
    const { tool, onCredits } = makeTool({ availableModels: [priced] });

    const result = await tool.toolFn({ task: 'Decompose this' });

    expect(result).toMatch(/coordinator agent failed/);
    expect(onCredits).toHaveBeenCalledWith(
      usdToCredits(getTextModelCost(priced, 12_000, 3_000)),
      expect.objectContaining({ model: coordinatorModel, inputTokens: 12_000, outputTokens: 3_000 })
    );
  });

  it('forwards checkInsufficientCredits to the coordinator orchestrator', async () => {
    let forwarded: unknown;
    vi.spyOn(ServerSubagentOrchestrator.prototype, 'delegateToAgent').mockImplementation(function (
      this: ServerSubagentOrchestrator
    ) {
      forwarded = (this as unknown as { deps: { checkInsufficientCredits?: unknown } }).deps.checkInsufficientCredits;
      return Promise.resolve(makeResult());
    });
    const checkInsufficientCredits = vi.fn().mockResolvedValue(false);
    const { tool } = makeTool({ checkInsufficientCredits });

    await tool.toolFn({ task: 'Decompose this' });

    expect(forwarded).toBe(checkInsufficientCredits);
  });
});
