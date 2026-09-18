import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { resolveAggregateToolModel, UNATTRIBUTED_TOOL_CHARGE } from '../settleToolCredits';

// delegate_to_agent is the one charging path whose model can be missing: delegateToAgent
// drops the usage event when the subagent model is absent from availableModels but still
// fires onCredits with the charge. Reaching that callback for real would mean running a
// subagent, so this captures the callbacks ToolBuilder hands to buildSharedTools and
// invokes onSubagentCredits directly - the same seam, without the orchestration.
const captured: { onSubagentCredits?: (credits: number, meta?: { model: string }) => void } = {};

vi.mock('../sharedToolBuilder', () => ({
  buildSharedTools: (_deps: unknown, callbacks: Record<string, unknown>) => {
    captured.onSubagentCredits = callbacks.onSubagentCredits as typeof captured.onSubagentCredits;
    return [];
  },
}));

const makeBuilder = () => {
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

  const builder = new ToolBuilder(deps);
  builder.buildTools({ quest: { id: 'q1', sessionId: 's1' }, saveQuest: vi.fn() } as never);
  return { toolCreditsMap, toolCreditModels };
};

beforeEach(() => {
  captured.onSubagentCredits = undefined;
});

describe('ToolBuilder delegate_to_agent credit attribution', () => {
  it('records the subagent model when it resolves', () => {
    const { toolCreditModels } = makeBuilder();

    captured.onSubagentCredits!(40, { model: 'global.anthropic.claude-haiku-4-5' });

    expect(resolveAggregateToolModel(toolCreditModels)).toBe('global.anthropic.claude-haiku-4-5');
  });

  it('records the unattributable sentinel when the subagent model could not be resolved', () => {
    const { toolCreditsMap, toolCreditModels } = makeBuilder();

    captured.onSubagentCredits!(40, undefined);

    // The charge still reaches the row's amount, so the set must show that SOME model is
    // unaccounted for rather than staying empty.
    expect(toolCreditsMap.get('delegate_to_agent')).toEqual([40]);
    expect(Array.from(toolCreditModels)).toEqual([UNATTRIBUTED_TOOL_CHARGE]);
    expect(resolveAggregateToolModel(toolCreditModels)).toBeUndefined();
  });

  it('blanks a row that mixes one known model with an unattributable charge', () => {
    // The regression this locks: gpt-image-2 charges and records, an unresolvable
    // delegation charges and records nothing, the set holds exactly one entry, and the row
    // gets stamped gpt-image-2 while its credits also cover the delegation.
    const { toolCreditModels } = makeBuilder();

    toolCreditModels.add('gpt-image-2');
    captured.onSubagentCredits!(40, undefined);

    expect(resolveAggregateToolModel(toolCreditModels)).toBeUndefined();
  });

  it('contributes nothing for a zero-credit delegation', () => {
    const { toolCreditModels } = makeBuilder();

    captured.onSubagentCredits!(0, undefined);

    expect(toolCreditModels.size).toBe(0);
  });
});
