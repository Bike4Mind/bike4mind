import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  findAgentsByName: vi.fn(),
  enrollMissionForAgent: vi.fn(),
  runMissionFirstWake: vi.fn(),
  assertOwnerCanAfford: vi.fn(),
}));

vi.mock('@server/deepAgent/missions', () => ({
  findAgentsByName: m.findAgentsByName,
  enrollMissionForAgent: m.enrollMissionForAgent,
  formatMissionStatusReport: vi.fn(),
  listMissionsForAgent: vi.fn(),
}));
vi.mock('@server/deepAgent/store', () => ({ MongoDeepAgentStore: class {} }));
vi.mock('@server/deepAgent/firstWake', () => ({ runMissionFirstWake: m.runMissionFirstWake }));
vi.mock('@server/deepAgent/wakeMetering', () => ({ assertOwnerCanFundWake: m.assertOwnerCanAfford }));

import { insufficientCreditsError } from '@bike4mind/common';
import { missionChatTools } from './missionChatTools';

const run = (user: { id: string; isAdmin?: boolean; tags?: string[] }) =>
  missionChatTools.create_mission
    .implementation({ userId: user.id, user } as never)
    .toolFn({ agentName: 'Cerebo', goal: 'Draft copy weekly' });

describe('create_mission chat tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findAgentsByName.mockResolvedValue([{ id: 'agent-1', name: 'Cerebo' }]);
    m.enrollMissionForAgent.mockResolvedValue({ missionId: 'mission-1' });
    m.runMissionFirstWake.mockResolvedValue({ handoff: { lastActionSummary: 'woke', nextIntendedAction: 'next' } });
  });

  it('refuses a caller who is neither admin nor developer, before enrolling or waking', async () => {
    const reply = await run({ id: 'u1', tags: [] });
    expect(reply).toMatch(/admins and developers only/);
    expect(m.enrollMissionForAgent).not.toHaveBeenCalled();
    expect(m.runMissionFirstWake).not.toHaveBeenCalled();
  });

  it('tells an out-of-credits caller no mission started, before enrolling or waking', async () => {
    m.assertOwnerCanAfford.mockRejectedValueOnce(insufficientCreditsError('Insufficient credits'));
    const reply = await run({ id: 'u1', tags: ['Developer'] });
    expect(reply).toMatch(/out of credits/);
    expect(m.enrollMissionForAgent).not.toHaveBeenCalled();
    expect(m.runMissionFirstWake).not.toHaveBeenCalled();
  });

  it('enrolls for a developer, passing whether the caller is an admin', async () => {
    await run({ id: 'u1', tags: ['Developer'] });
    expect(m.enrollMissionForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ callerUserId: 'u1', callerIsAdmin: false }),
      expect.anything()
    );
    expect(m.runMissionFirstWake).toHaveBeenCalledOnce();
  });
});
