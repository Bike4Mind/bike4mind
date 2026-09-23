import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { ServerAgentStore } from '../agents/ServerAgentStore';
import { ServerSubagentOrchestrator, type ServerAgentExecutionResult } from '../agents/ServerSubagentOrchestrator';
import { resolveAggregateToolModel, UNATTRIBUTED_TOOL_CHARGE } from '../settleToolCredits';

// delegate_to_agent is the one charging path whose model can be missing: delegateToAgent
// drops the usage event when the subagent's model is absent from availableModels but still
// fires onCredits with the charge. That state is unreachable from the UI (the agent picker
// only offers listed models), so it is covered here instead - through the REAL
// buildSharedTools wiring, stubbing only the orchestrator call that would run a subagent.
// Everything between the tool's return and the charging-model set is production code.
const PARENT_MODEL = 'gpt-4.1-mini';

const parentModelInfo = {
  id: PARENT_MODEL,
  name: PARENT_MODEL,
  type: 'chat',
  backend: ModelBackend.OpenAI,
  // getTextModelCost reads this to price the resolvable case; a bare ModelInfo throws.
  pricing: { 128_000: { input: 0.4, output: 1.6 } },
} as unknown as ModelInfo;

const makeLlm = () =>
  ({
    currentModel: PARENT_MODEL,
    complete: vi.fn(),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  }) as unknown as ICompletionBackend;

/** Stub the subagent run itself; `model` is what delegateToAgent looks up in availableModels. */
const mockDelegation = (model: string, totalCredits = 40) =>
  vi.spyOn(ServerSubagentOrchestrator.prototype, 'delegateToAgent').mockResolvedValue({
    agentName: 'researcher',
    thoroughness: 'medium',
    summary: 'done',
    finalAnswer: 'done',
    model,
    steps: [],
    completionInfo: {
      totalTokens: 15_000,
      totalInputTokens: 12_000,
      totalOutputTokens: 3_000,
      totalCredits,
      iterations: 1,
      toolCalls: 0,
      reachedMaxIterations: false,
    },
  } as ServerAgentExecutionResult);

const buildDelegateTool = () => {
  const toolCreditsMap = new Map<string, number[]>();
  const toolCreditModels = new Set<string>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };
  const deps = {
    user: { id: 'u1', currentCredits: 1_000_000 },
    logger,
    db: { creditTransactions: {}, usageEvents: { record: vi.fn().mockResolvedValue(undefined) } },
    toolCreditsMap,
    toolCreditModels,
    subagentTelemetryData: [],
    sendStatusUpdate: vi.fn().mockResolvedValue(undefined),
    extraContextMessages: [],
  } as unknown as ToolBuilderConfig;

  const tools = new ToolBuilder(deps).buildTools({
    enabledTools: [],
    quest: { id: 'q1', sessionId: 's1' },
    saveQuest: vi.fn().mockResolvedValue(null),
    llm: makeLlm(),
    model: PARENT_MODEL,
    organization: null,
    // availableModels for the delegation is precomputed.models, so a subagent that
    // reports any OTHER id is the unattributable case.
    precomputed: { adminSettingsEnforceCredits: true, models: [parentModelInfo] },
    apiKeyTable: { openai: 'sk-test' },
    agentStore: new ServerAgentStore({}),
    getAbortSignal: () => undefined,
  } as never);

  const delegateTool = tools?.find(
    t => (t as { toolSchema?: { name?: string } }).toolSchema?.name === 'delegate_to_agent'
  );
  if (!delegateTool) throw new Error('delegate_to_agent was not built');
  return {
    delegateTool: delegateTool as unknown as { toolFn: (args: unknown) => Promise<unknown> },
    toolCreditsMap,
    toolCreditModels,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToolBuilder delegate_to_agent credit attribution', () => {
  it('names the subagent model when it resolves', async () => {
    mockDelegation(PARENT_MODEL);
    const { delegateTool, toolCreditModels } = buildDelegateTool();

    await delegateTool.toolFn({ task: 'research', agent: 'researcher' });

    expect(resolveAggregateToolModel(toolCreditModels)).toBe(PARENT_MODEL);
  });

  it('records the unattributable sentinel when the subagent model is not in availableModels', async () => {
    mockDelegation('gpt-4.1-nano-not-listed');
    const { delegateTool, toolCreditsMap, toolCreditModels } = buildDelegateTool();

    await delegateTool.toolFn({ task: 'research', agent: 'researcher' });

    // The charge still reaches the row's amount, so the set must show that SOME model is
    // unaccounted for rather than staying empty.
    expect(toolCreditsMap.get('delegate_to_agent')).toEqual([40]);
    expect(Array.from(toolCreditModels)).toEqual([UNATTRIBUTED_TOOL_CHARGE]);
    expect(resolveAggregateToolModel(toolCreditModels)).toBeUndefined();
  });

  it('blanks a row that mixes one known model with an unattributable charge', async () => {
    // The regression this locks: gpt-image-2 charges and records its model, an
    // unresolvable delegation charges and records nothing, the set holds exactly one
    // entry, and the row gets stamped gpt-image-2 while its credits also cover the
    // delegation - authoritative and wrong.
    mockDelegation('gpt-4.1-nano-not-listed');
    const { delegateTool, toolCreditModels } = buildDelegateTool();
    toolCreditModels.add('gpt-image-2');

    await delegateTool.toolFn({ task: 'research', agent: 'researcher' });

    expect(resolveAggregateToolModel(toolCreditModels)).toBeUndefined();
  });

  it('contributes nothing for a zero-credit delegation', async () => {
    mockDelegation('gpt-4.1-nano-not-listed', 0);
    const { delegateTool, toolCreditModels } = buildDelegateTool();

    await delegateTool.toolFn({ task: 'research', agent: 'researcher' });

    expect(toolCreditModels.size).toBe(0);
  });
});
