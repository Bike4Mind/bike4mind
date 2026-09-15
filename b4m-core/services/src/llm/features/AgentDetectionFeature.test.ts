import { describe, it, expect, vi } from 'vitest';
import { AgentDetectionFeature } from './AgentDetectionFeature';
import type { ChatCompletionContext } from '../ChatCompletionFeatures';

/**
 * Pins the one AgentDetectionFeature behavior the `delegate_to_agent` gate depends on: a persona
 * @mention is written back onto the SAME `session` object, in place, during beforeDataGathering -
 * which runs before ChatCompletionProcess computes `shouldOfferDelegation`. That ordering is why
 * narrowing the gate's @mention arm to store-runnable agents loses no reachable behavior: a
 * mention naming a real persona still reaches the gate, via `session.agentIds` rather than via the
 * mention arm. If this write ever stops happening (or stops mutating the caller's object), that
 * argument breaks and persona summons silently lose delegation.
 */
const buildContext = (agents: Array<{ id: string; name: string }>) => {
  const attachAgent = vi.fn().mockResolvedValue(undefined);
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const context = {
    logger,
    user: { id: 'user-1' },
    db: {
      agents: {
        findByTriggerWords: vi.fn().mockResolvedValue(agents),
        findById: vi.fn().mockImplementation(async (id: string) => agents.find(a => a.id === id) ?? null),
      },
      sessions: { attachAgent },
    },
  } as unknown as ChatCompletionContext;
  return { context, attachAgent };
};

const runDetection = async (
  context: ChatCompletionContext,
  session: { id: string; agentIds?: string[] },
  message: string
) => {
  const feature = new AgentDetectionFeature(context);
  // Only the fields AgentDetectionFeature reads are populated; the rest of the arg bag is inert
  // for this path.
  await feature.beforeDataGathering({
    quest: {} as never,
    session: session as never,
    startParams: {},
    llm: undefined,
    model: 'gpt-4',
    message,
    historyCount: 0,
    fabFileIds: [],
    questId: 'quest-1',
  });
};

describe('AgentDetectionFeature session attachment', () => {
  it('writes a resolved persona mention onto the caller session object in place', async () => {
    const { context, attachAgent } = buildContext([{ id: 'agent-1', name: 'coffee-bot' }]);
    const session = { id: 'session-1', agentIds: [] as string[] };

    await runDetection(context, session, '@coffee-bot what should I order');

    expect(attachAgent).toHaveBeenCalledWith('session-1', 'agent-1');
    expect(session.agentIds).toEqual(['agent-1']);
  });

  it('leaves the session untouched when the mention resolves to no agent', async () => {
    const { context, attachAgent } = buildContext([]);
    const session = { id: 'session-1', agentIds: [] as string[] };

    await runDetection(context, session, 'can you loop in @dave on this thread');

    expect(attachAgent).not.toHaveBeenCalled();
    expect(session.agentIds).toEqual([]);
  });

  it('does not re-attach an agent already on the session', async () => {
    const { context, attachAgent } = buildContext([{ id: 'agent-1', name: 'coffee-bot' }]);
    const session = { id: 'session-1', agentIds: ['agent-1'] };

    await runDetection(context, session, 'anything at all');

    expect(attachAgent).not.toHaveBeenCalled();
    expect(session.agentIds).toEqual(['agent-1']);
  });
});
