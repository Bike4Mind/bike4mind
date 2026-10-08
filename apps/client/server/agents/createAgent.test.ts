import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  countByUserId: vi.fn(),
  agentCreate: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, incrementCredits: vi.fn() },
  agentRepository: { countByUserId: h.countByUserId, create: h.agentCreate },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

import { AGENT_LIMIT_REACHED_ERROR_CODE } from '@bike4mind/common';
import { createAgent } from './createAgent';

describe('createAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ id: 'user-1', level: 'DemoUser', currentCredits: 0 });
    h.agentCreate.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'agent-1', ...data }));
  });

  it('tags the per-tier cap rejection with agent_limit_reached and creates nothing', async () => {
    h.countByUserId.mockResolvedValue(2);

    const error = await createAgent({ name: 'Agent' }, 'user-1').catch(e => e);

    expect(error).toMatchObject({
      name: 'BadRequestError',
      statusCode: 400,
      message: 'Agent limit reached for your tier (2 max)',
      additionalInfo: { errorCode: AGENT_LIMIT_REACHED_ERROR_CODE },
    });
    expect(h.agentCreate).not.toHaveBeenCalled();
  });

  it('leaves other rejections untagged', async () => {
    const error = await createAgent({ name: 'Agent', preferredModel: 'not-a-model' }, 'user-1').catch(e => e);

    expect(error).toMatchObject({ name: 'BadRequestError', message: 'Invalid model: not-a-model' });
    expect(error.additionalInfo).toBeUndefined();
  });

  it('creates the agent for the caller under the cap', async () => {
    h.countByUserId.mockResolvedValue(1);

    const { agent, userCredits } = await createAgent({ name: 'Agent' }, 'user-1');

    expect(agent).toMatchObject({ id: 'agent-1', name: 'Agent', userId: 'user-1', useOwnCredits: false });
    expect(userCredits).toBe(0);
  });
});
