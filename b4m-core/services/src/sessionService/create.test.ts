import { describe, it, expect, vi, beforeEach } from 'vitest';

// createSession imports projectService from the services barrel ('..'); stub it so the
// heavy barrel is not loaded. addSessions is only reached when a projectId resolves, which
// these tests never do.
vi.mock('..', () => ({
  projectService: { addSessions: vi.fn() },
}));

import { createSession } from './create';
import { IUserDocument } from '@bike4mind/common';

describe('createSession - agent object-level authz', () => {
  const user = { id: 'attacker' } as IUserDocument;

  // accessibleAgentIds: what shareable.findAllAccessibleByIds returns (owner + shares).
  const makeAdapters = (accessibleAgentIds: string[]) => {
    const create = vi.fn().mockResolvedValue({ id: 'session-1' });
    const findAllAccessibleByIds = vi.fn().mockResolvedValue(accessibleAgentIds.map(id => ({ id })));
    return {
      create,
      findAllAccessibleByIds,
      adapters: {
        db: {
          sessions: { create },
          projects: {},
          fabFiles: {},
          agents: { shareable: { findAllAccessibleByIds } },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
        } as any,
      },
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it('drops an agent id the caller cannot access, storing only accessible ones', async () => {
    // Caller supplies their own agent plus a victim's; only their own is accessible.
    const { create, adapters } = makeAdapters(['own-agent']);

    await createSession(user, { name: 'S', agentIds: ['own-agent', 'victim-agent'] }, adapters);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].agentIds).toEqual(['own-agent']);
  });

  it('keeps a group-shared agent (no over-denial)', async () => {
    // findAllAccessibleByIds honors owner + user-shares + group-shares, so a group-shared
    // agent the caller does not own still resolves and is attached.
    const { create, adapters } = makeAdapters(['group-shared-agent']);

    await createSession(user, { name: 'S', agentIds: ['group-shared-agent'] }, adapters);

    expect(create.mock.calls[0][0].agentIds).toEqual(['group-shared-agent']);
  });

  it('does not query the agents repo when no agentIds are supplied', async () => {
    const { create, findAllAccessibleByIds, adapters } = makeAdapters([]);

    await createSession(user, { name: 'S' }, adapters);

    expect(findAllAccessibleByIds).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].agentIds).toEqual([]);
  });
});
