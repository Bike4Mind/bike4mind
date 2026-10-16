import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IAgent } from '@bike4mind/common';

const refreshAgentAvatarUrls = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls }));

import { presentAgentsForViewer } from './presentAgentsForViewer';

const createdAt = new Date('2026-01-01T00:00:00Z');
const updatedAt = new Date('2026-02-01T00:00:00Z');

const agent = (userId: string) =>
  ({
    id: `agent-${userId}`,
    userId,
    name: 'Ada',
    description: 'helper',
    type: 'persona',
    isPublic: false,
    triggerWords: ['@ada'],
    capabilities: ['research'],
    projectId: 'project-1',
    useOwnCredits: true,
    preferredModel: 'model-a',
    preferredImageModel: 'image-a',
    temperature: 0.4,
    maxTokens: 900,
    allowedTools: ['web_search'],
    deniedTools: ['shell'],
    maxIterations: { quick: 1, medium: 2, very_thorough: 3 },
    defaultThoroughness: 'medium',
    personality: { majorMotivation: 'm', minorMotivation: 'n', flaw: 'f', quirk: 'q', description: 'd' },
    identity: { gender: 'other', pronouns: { subject: 'they' } },
    visual: { portraitUrl: 'https://img/p.png', style: 'ink', generationPrompt: 'owner prompt' },
    createdAt,
    updatedAt,
    // Owner-only below.
    systemPrompt: 'secret prompt',
    currentCredits: 500,
    lastCreditsPurchasedAt: updatedAt,
    memoryJournal: [{ id: 'm1', content: 'private memory' }],
    worldMemory: [{ id: 'w1', description: 'built a room' }],
    pendingMessages: [{ id: 'p1', text: 'hi' }],
    conversationCooldowns: [{ otherAgentId: 'x' }],
    heartbeatConfig: { enabled: true, intervalMinutes: 5 },
    memoryConfig: { maxEntries: 10, summarizeThreshold: 5 },
    tavernStats: { xp: 1 },
    tavernSessionId: `session-${userId}`,
    currentFloorId: 'surface',
    users: [{ userId: 'viewer', permissions: ['read'] }],
    defaultVariables: { k: 'v' },
    exclusiveMcpServers: ['mcp'],
    fallbackModels: ['model-b'],
    elevenLabsAgentId: 'el-1',
  }) as unknown as IAgent;

describe('presentAgentsForViewer', () => {
  beforeEach(() => {
    refreshAgentAvatarUrls.mockReset();
    refreshAgentAvatarUrls.mockImplementation(async (agents: IAgent[]) => agents);
  });

  it('returns the owner their agent unchanged', async () => {
    const own = agent('viewer');
    const [presented] = await presentAgentsForViewer([own], 'viewer');

    expect(presented).toBe(own);
  });

  it('returns a non-owner only the allowlisted fields', async () => {
    const [presented] = await presentAgentsForViewer([agent('other')], 'viewer');

    expect(presented).toEqual({
      id: 'agent-other',
      name: 'Ada',
      description: 'helper',
      type: 'persona',
      isPublic: false,
      triggerWords: ['@ada'],
      capabilities: ['research'],
      projectId: 'project-1',
      useOwnCredits: true,
      preferredModel: 'model-a',
      preferredImageModel: 'image-a',
      temperature: 0.4,
      maxTokens: 900,
      allowedTools: ['web_search'],
      deniedTools: ['shell'],
      maxIterations: { quick: 1, medium: 2, very_thorough: 3 },
      defaultThoroughness: 'medium',
      personality: { majorMotivation: 'm', minorMotivation: 'n', flaw: 'f', quirk: 'q', description: 'd' },
      identity: { gender: 'other', pronouns: { subject: 'they' } },
      visual: { portraitUrl: 'https://img/p.png', style: 'ink' },
      createdAt,
      updatedAt,
    });
  });

  it('defaults triggerWords for a non-owner, since the mention UI iterates it unguarded', async () => {
    const legacy = { ...agent('other'), triggerWords: undefined } as unknown as IAgent;
    const [presented] = await presentAgentsForViewer([legacy], 'viewer');

    expect(presented.triggerWords).toEqual([]);
  });

  it('projects the avatar-refreshed agents, not the originals', async () => {
    refreshAgentAvatarUrls.mockImplementation(async (agents: IAgent[]) =>
      agents.map(a => ({ ...a, visual: { ...a.visual, portraitUrl: 'fresh' } }))
    );

    const [presented] = await presentAgentsForViewer([agent('other')], 'viewer');

    expect(presented.visual).toEqual({ portraitUrl: 'fresh', style: 'ink' });
    expect(refreshAgentAvatarUrls).toHaveBeenCalledWith([agent('other')], 'viewer');
  });
});
