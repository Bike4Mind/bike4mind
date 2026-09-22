import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { getEligibleConfigs } from './getEligibleConfigs';
import { createMockSessionAgentConfigRepository, createMockSessionRepository } from '../__tests__/utils/testUtils';
import { ISessionAgentConfigRepository, ISessionRepository } from '@bike4mind/common';

function loggerStub() {
  return {
    warn: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  } as unknown as Parameters<typeof getEligibleConfigs>[0]['logger'];
}

const BASE_CONFIG = {
  id: 'config-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
  userId: 'user-1',
  proactiveMessaging: {
    enabled: true,
    activeHours: { startHour: 0, endHour: 23 },
    minIntervalHours: 24,
  },
};

describe('getEligibleConfigs - stale config cleanup', () => {
  let mockConfigRepo: ISessionAgentConfigRepository;
  let mockSessionRepo: ISessionRepository;

  beforeEach(() => {
    mockConfigRepo = createMockSessionAgentConfigRepository();
    mockSessionRepo = createMockSessionRepository();
    (mockConfigRepo.findAllWithProactiveMessagingEnabled as Mock).mockResolvedValue([BASE_CONFIG]);
  });

  // A detach + cleanup race (or a session tombstoned outside the transactional detach path) can
  // leave an enabled row with no session behind it; this is the backstop that keeps it from being
  // rescanned forever with nothing to clear it.
  it('deletes a config whose session no longer exists', async () => {
    (mockSessionRepo.findById as Mock).mockResolvedValue(null);

    const eligible = await getEligibleConfigs({
      db: { sessionAgentConfigs: mockConfigRepo, sessions: mockSessionRepo },
      logger: loggerStub(),
    });

    expect(eligible).toEqual([]);
    expect(mockConfigRepo.deleteBySessionAndAgent).toHaveBeenCalledWith('session-1', 'agent-1');
  });

  it('deletes a config whose session is soft-deleted', async () => {
    (mockSessionRepo.findById as Mock).mockResolvedValue({ id: 'session-1', deletedAt: new Date() });

    const eligible = await getEligibleConfigs({
      db: { sessionAgentConfigs: mockConfigRepo, sessions: mockSessionRepo },
      logger: loggerStub(),
    });

    expect(eligible).toEqual([]);
    expect(mockConfigRepo.deleteBySessionAndAgent).toHaveBeenCalledWith('session-1', 'agent-1');
  });

  // The closes-the-race case: a config PUT can recreate an enabled row for an agent that was just
  // detached (assertAgentAttached passes on the session's own agentIds before the PUT lands, the
  // detach route's cleanup already ran and saw nothing to delete). The next scan still catches it,
  // since it re-derives attachment from the session itself rather than trusting the row's existence.
  it('deletes a config for an agent no longer attached to its session', async () => {
    (mockSessionRepo.findById as Mock).mockResolvedValue({ id: 'session-1', deletedAt: null });
    (mockSessionRepo.getAttachedAgents as Mock).mockResolvedValue([]);

    const eligible = await getEligibleConfigs({
      db: { sessionAgentConfigs: mockConfigRepo, sessions: mockSessionRepo },
      logger: loggerStub(),
    });

    expect(eligible).toEqual([]);
    expect(mockConfigRepo.deleteBySessionAndAgent).toHaveBeenCalledWith('session-1', 'agent-1');
  });

  it('leaves a live, attached config alone', async () => {
    (mockSessionRepo.findById as Mock).mockResolvedValue({ id: 'session-1', deletedAt: null });
    (mockSessionRepo.getAttachedAgents as Mock).mockResolvedValue(['agent-1']);

    const eligible = await getEligibleConfigs({
      db: { sessionAgentConfigs: mockConfigRepo, sessions: mockSessionRepo },
      logger: loggerStub(),
    });

    expect(eligible).toEqual([BASE_CONFIG]);
    expect(mockConfigRepo.deleteBySessionAndAgent).not.toHaveBeenCalled();
  });
});
