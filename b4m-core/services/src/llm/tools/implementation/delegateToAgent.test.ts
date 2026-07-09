import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { filterToolsByPatterns } from '@bike4mind/agents';
import { getTextModelCost, type ModelInfo } from '@bike4mind/common';
import { ServerAgentStore } from '../../agents/ServerAgentStore';
import {
  MAX_SUBAGENT_DEPTH,
  PARENT_DEADLINE_BUFFER_MS,
  ServerSubagentOrchestrator,
} from '../../agents/ServerSubagentOrchestrator';
import type {
  ServerSubagentTracker,
  ChildExecutionStatus,
  ServerAgentExecutionResult,
} from '../../agents/ServerSubagentOrchestrator';
import { createDelegateToAgentTool, type SubagentUsageMeta } from './delegateToAgent';

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

function makeStore(): ServerAgentStore {
  // Use the built-in `researcher` agent - exists in ServerAgentStore by default.
  return new ServerAgentStore({});
}

function makeTracker(): ServerSubagentTracker {
  return {
    onStart: vi.fn().mockResolvedValue('bg-child-id'),
    onComplete: vi.fn().mockResolvedValue(undefined),
    onFailure: vi.fn().mockResolvedValue(undefined),
    onLambdaDispatch: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createDelegateToAgentTool — background mode', () => {
  it('background: true returns structured payload without running the agent in-process', async () => {
    const tracker = makeTracker();
    const onTelemetry = vi.fn();

    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      tracker,
      onTelemetry,
    });

    const result = await tool.toolFn({
      task: 'Find weather data for Tokyo',
      agent: 'researcher',
      background: true,
    });

    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result as string);
    expect(parsed).toMatchObject({
      status: 'background_started',
      childExecutionId: 'bg-child-id',
      agentName: 'researcher',
    });
    expect(parsed.message).toContain('background');

    expect(tracker.onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'researcher',
        isBackground: true,
        willDispatchToLambda: true,
      })
    );
    expect(tracker.onLambdaDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        childExecutionId: 'bg-child-id',
        isBackground: true,
      })
    );
    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'researcher',
        success: true,
        iterations: 0,
        totalTokensUsed: 0,
      })
    );
  });

  it('background param appears in tool schema with boolean type', () => {
    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
    });

    const props = tool.toolSchema.parameters.properties as Record<string, { type: string; description: string }>;
    expect(props.background).toBeDefined();
    expect(props.background.type).toBe('boolean');
    expect(props.background.description).toMatch(/background/i);
    // `background` is intentionally NOT required - defaults to false (in-process).
    expect(tool.toolSchema.parameters.required).toEqual(['task', 'agent']);
  });

  it('returns a tool_result error string and emits failure telemetry when task is missing', async () => {
    const onTelemetry = vi.fn();
    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      onTelemetry,
    });

    const result = await tool.toolFn({ agent: 'researcher' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/task/i);
    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'researcher',
        success: false,
        error: expect.stringContaining('task'),
      })
    );
  });

  it('returns a tool_result error string and emits failure telemetry when agent is missing', async () => {
    const onTelemetry = vi.fn();
    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      onTelemetry,
    });

    const result = await tool.toolFn({ task: 'do something' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/agent/i);
    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'unknown',
        success: false,
        error: expect.stringContaining('agent'),
      })
    );
  });

  it('returns a tool_result error string and emits failure telemetry when agent is unknown', async () => {
    const onTelemetry = vi.fn();
    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      onTelemetry,
    });

    const result = await tool.toolFn({ task: 'do something', agent: 'nonexistent-agent' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/unknown agent/i);
    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'nonexistent-agent',
        success: false,
        error: expect.stringContaining('nonexistent-agent'),
      })
    );
  });

  it('background mode reports telemetry failure when tracker rejects', async () => {
    const tracker: ServerSubagentTracker = {
      onStart: vi.fn().mockRejectedValue(new Error('tracker exploded')),
      onComplete: vi.fn(),
      onFailure: vi.fn(),
      onLambdaDispatch: vi.fn(),
    };
    const onTelemetry = vi.fn();

    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      tracker,
      onTelemetry,
    });

    await expect(tool.toolFn({ task: 't', agent: 'researcher', background: true })).rejects.toThrow();

    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'researcher',
        success: false,
        error: expect.stringContaining('tracker exploded'),
      })
    );
  });
});

describe('createDelegateToAgentTool — depth cap enforcement (#8577)', () => {
  it('depth propagates through background dispatch chain: child receives parent depth + 1', async () => {
    const capturedDepths: Array<number | undefined> = [];

    async function dispatchAtDepth(depth: number | undefined) {
      const tracker: ServerSubagentTracker = {
        ...makeTracker(),
        onLambdaDispatch: vi.fn().mockImplementation(async (info: { depth?: number }) => {
          capturedDepths.push(info.depth);
        }),
      };
      const tool = createDelegateToAgentTool({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        agentStore: makeStore(),
        tracker,
        ...(depth !== undefined ? { depth } : {}),
      });
      await tool.toolFn({ task: 't', agent: 'researcher', background: true });
    }

    await dispatchAtDepth(undefined); // parent depth unset (0) → child depth 1
    await dispatchAtDepth(1); // parent depth 1 → child depth 2
    await dispatchAtDepth(2); // parent depth 2 → child depth MAX_SUBAGENT_DEPTH (3)

    expect(capturedDepths).toEqual([1, 2, MAX_SUBAGENT_DEPTH]);
  });

  it('sync-dispatch (dispatchAndPollSubagent) propagates depth to onLambdaDispatch identically to background dispatch', async () => {
    // getRemainingTimeMs must be:
    //   - above PARENT_DEADLINE_BUFFER_MS so the poll-loop deadline check doesn't short-circuit
    //   - below SUBAGENT_TIMEOUT_BY_THOROUGHNESS['quick'] + PARENT_INPROCESS_SAFETY_MS (not exported; 60s)
    //     so shouldDispatchToLambda fires and the sync path is taken
    const remainingMs = PARENT_DEADLINE_BUFFER_MS + 1; // 90_001 ms: just above floor, well below dispatch threshold

    const capturedDepths: Array<number | undefined> = [];
    const completedStatus: ChildExecutionStatus = { status: 'completed', result: { answer: 'done' } };

    const tracker: ServerSubagentTracker = {
      onStart: vi.fn().mockResolvedValue('sync-child-id'),
      onComplete: vi.fn().mockResolvedValue(undefined),
      onFailure: vi.fn().mockResolvedValue(undefined),
      onLambdaDispatch: vi.fn().mockImplementation(async (info: { depth?: number }) => {
        capturedDepths.push(info.depth);
      }),
      pollChildStatus: vi.fn().mockResolvedValue(completedStatus),
    };

    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      tracker,
      depth: 1,
      getRemainingTimeMs: () => remainingMs,
    });

    await tool.toolFn({ task: 't', agent: 'researcher' }); // background: false (default) → sync dispatch

    expect(tracker.onLambdaDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 2 }) // parent depth=1 → child depth=2
    );
    expect(capturedDepths).toEqual([2]);
  });

  it('filterToolsByPatterns strips delegate_to_agent at depth cap, mirroring orchestrator behavior', () => {
    const delegateTool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
    });

    // Confirm the tool is present before filtering.
    const allTools = [delegateTool];
    expect(allTools.some(t => t.toolSchema.name === 'delegate_to_agent')).toBe(true);

    // At depth >= MAX_SUBAGENT_DEPTH, ServerSubagentOrchestrator adds
    // 'delegate_to_agent' to DEPTH_CAP_DENIED and passes it to filterToolsByPatterns.
    const capped = filterToolsByPatterns(allTools, undefined, ['delegate_to_agent']);
    expect(capped.some(t => t.toolSchema.name === 'delegate_to_agent')).toBe(false);
  });
});

describe('createDelegateToAgentTool — usage-event cost basis (#151)', () => {
  const MODEL_ID = 'claude-sonnet-4-6';
  // Numeric-keyed tier: inputTokens <= threshold selects this pricing. No explicit
  // cache rates, so getTextModelCost derives them from `input` via the cache
  // multipliers (0.1x read, 1.25x write).
  const model: ModelInfo = {
    id: MODEL_ID,
    backend: 'bedrock',
    pricing: { 1_000_000: { input: 0.000003, output: 0.000015 } },
  } as unknown as ModelInfo;

  function makeResult(overrides: Partial<ServerAgentExecutionResult['completionInfo']>): ServerAgentExecutionResult {
    return {
      agentName: 'researcher',
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
        iterations: 3,
        toolCalls: 2,
        reachedMaxIterations: false,
        ...overrides,
      },
    } as ServerAgentExecutionResult;
  }

  // Spy on the prototype method so the real constructor still runs (background
  // and depth tests elsewhere in this file depend on the un-mocked orchestrator).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockDelegation(result: ServerAgentExecutionResult): void {
    vi.spyOn(ServerSubagentOrchestrator.prototype, 'delegateToAgent').mockResolvedValue(result);
  }

  it('threads subagent cache tokens into the usage meta and computes cost on the cache-aware basis', async () => {
    const inputTokens = 12_000;
    const outputTokens = 3_000;
    const cacheReadTokens = 40_000;
    const cacheWriteTokens = 5_000;
    mockDelegation(
      makeResult({
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalCacheReadTokens: cacheReadTokens,
        totalCacheWriteTokens: cacheWriteTokens,
      })
    );

    let captured: SubagentUsageMeta | undefined;
    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      availableModels: [model],
      onCredits: (_credits, meta) => {
        captured = meta;
      },
    });

    await tool.toolFn({ task: 'research', agent: 'researcher' });

    expect(captured).toBeDefined();
    expect(captured!.cacheReadTokens).toBe(cacheReadTokens);
    expect(captured!.cacheWriteTokens).toBe(cacheWriteTokens);
    // Cost matches getTextModelCost WITH the cache args - the same separate-bucket
    // basis cliCompletions uses to compute the subagent's credits (input_tokens
    // excludes cache tokens, so the cache buckets are additive). This is the whole
    // point of #151: costUsd now sits on the same basis as creditsCharged.
    expect(captured!.usdCost).toBeCloseTo(
      getTextModelCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
      12
    );
    // PR #132 dropped the cache buckets, understating cost by exactly their
    // contribution; the fixed cost is strictly higher than that cache-blind value.
    expect(captured!.usdCost).toBeGreaterThan(getTextModelCost(model, inputTokens, outputTokens));
  });

  it('defaults cache tokens to 0 when the subagent reports none', async () => {
    mockDelegation(makeResult({ totalCacheReadTokens: undefined, totalCacheWriteTokens: undefined }));

    let captured: SubagentUsageMeta | undefined;
    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      agentStore: makeStore(),
      availableModels: [model],
      onCredits: (_credits, meta) => {
        captured = meta;
      },
    });

    await tool.toolFn({ task: 'research', agent: 'researcher' });

    expect(captured).toBeDefined();
    expect(captured!.cacheReadTokens).toBe(0);
    expect(captured!.cacheWriteTokens).toBe(0);
  });

  it('drops the usage meta and warns when the model is not in availableModels (#152)', async () => {
    mockDelegation(makeResult({}));

    let captured: SubagentUsageMeta | undefined = {} as SubagentUsageMeta;
    const logger = makeLogger();
    const tool = createDelegateToAgentTool({
      userId: 'u1',
      llm: makeLlm(),
      logger,
      parentTools: [],
      agentStore: makeStore(),
      // Model resolvable list does not contain MODEL_ID, so cost attribution misses.
      availableModels: [],
      onCredits: (_credits, meta) => {
        captured = meta;
      },
    });

    await tool.toolFn({ task: 'research', agent: 'researcher' });

    // Credits are still charged (onCredits fired) but no meta -> event is dropped.
    expect(captured).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(MODEL_ID));
  });
});
