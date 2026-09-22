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

describe('getEligibleConfigs - stale config handling', () => {
  let mockConfigRepo: ISessionAgentConfigRepository;
  let mockSessionRepo: ISessionRepository;

  beforeEach(() => {
    mockConfigRepo = createMockSessionAgentConfigRepository();
    mockSessionRepo = createMockSessionRepository();
    (mockConfigRepo.findAllWithProactiveMessagingEnabled as Mock).mockResolvedValue([BASE_CONFIG]);
  });

  // Skips rather than deletes: this scan's view of session/attachment state can be stale by the
  // time it would act on it (e.g. a reattach + PUT landing right after this read), so deleting by
  // (sessionId, agentId) risks destroying a config that became valid again in between. The worker
  // independently revalidates access before executing, so a truly orphaned row is inert.
  it('skips a config whose session no longer exists without deleting it', async () => {
    (mockSessionRepo.findById as Mock).mockResolvedValue(null);

    const eligible = await getEligibleConfigs({
      db: { sessionAgentConfigs: mockConfigRepo, sessions: mockSessionRepo },
      logger: loggerStub(),
    });

    expect(eligible).toEqual([]);
    expect(mockConfigRepo.deleteBySessionAndAgent).not.toHaveBeenCalled();
  });

  it('skips a config whose session is soft-deleted without deleting it', async () => {
    (mockSessionRepo.findById as Mock).mockResolvedValue({ id: 'session-1', deletedAt: new Date() });

    const eligible = await getEligibleConfigs({
      db: { sessionAgentConfigs: mockConfigRepo, sessions: mockSessionRepo },
      logger: loggerStub(),
    });

    expect(eligible).toEqual([]);
    expect(mockConfigRepo.deleteBySessionAndAgent).not.toHaveBeenCalled();
  });

  it('skips a config for an agent no longer attached to its session without deleting it', async () => {
    (mockSessionRepo.findById as Mock).mockResolvedValue({ id: 'session-1', deletedAt: null });
    (mockSessionRepo.getAttachedAgents as Mock).mockResolvedValue([]);

    const eligible = await getEligibleConfigs({
      db: { sessionAgentConfigs: mockConfigRepo, sessions: mockSessionRepo },
      logger: loggerStub(),
    });

    expect(eligible).toEqual([]);
    expect(mockConfigRepo.deleteBySessionAndAgent).not.toHaveBeenCalled();
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
