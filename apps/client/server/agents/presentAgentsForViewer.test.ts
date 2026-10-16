import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IAgent } from '@bike4mind/common';

const refreshAgentAvatarUrls = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls }));

import { presentAgentsForViewer } from './presentAgentsForViewer';

const agent = (userId: string) => ({ id: `agent-${userId}`, userId, tavernSessionId: `session-${userId}` }) as IAgent;

describe('presentAgentsForViewer', () => {
  beforeEach(() => {
    refreshAgentAvatarUrls.mockReset();
    refreshAgentAvatarUrls.mockImplementation(async (agents: IAgent[]) => agents);
  });

  it('keeps tavernSessionId on agents the viewer owns and strips it from the rest', async () => {
    const presented = await presentAgentsForViewer([agent('viewer'), agent('other')], 'viewer');

    expect(presented[0]).toMatchObject({ id: 'agent-viewer', tavernSessionId: 'session-viewer' });
    expect(presented[1]).toMatchObject({ id: 'agent-other' });
    expect(presented[1]).not.toHaveProperty('tavernSessionId');
  });

  it('redacts the avatar-refreshed agents, not the originals', async () => {
    refreshAgentAvatarUrls.mockImplementation(async (agents: IAgent[]) =>
      agents.map(a => ({ ...a, visual: { portraitUrl: 'fresh' } }))
    );

    const [presented] = await presentAgentsForViewer([agent('other')], 'viewer');

    expect(presented).toMatchObject({ visual: { portraitUrl: 'fresh' } });
    expect(presented).not.toHaveProperty('tavernSessionId');
    expect(refreshAgentAvatarUrls).toHaveBeenCalledWith([agent('other')], 'viewer');
  });

  it('redacts the session pointer from agents with no owner, for every viewer', async () => {
    const unowned = [
      { id: 'system', tavernSessionId: 'session-system' },
      { id: 'org', userId: null, tavernSessionId: 'session-org' },
    ] as unknown as IAgent[];

    const presented = await presentAgentsForViewer(unowned, 'viewer');

    expect(presented[0]).not.toHaveProperty('tavernSessionId');
    expect(presented[1]).not.toHaveProperty('tavernSessionId');
  });
});
