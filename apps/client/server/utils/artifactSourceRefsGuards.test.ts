import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUpdateAccessById: vi.fn(),
  sessionFindById: vi.fn(),
  questFindById: vi.fn(),
  artifactFindOne: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findById: mocks.sessionFindById,
    shareable: { findUpdateAccessById: mocks.findUpdateAccessById },
  },
  questRepository: { findById: mocks.questFindById },
  artifactRepository: { findOne: mocks.artifactFindOne },
}));

import { createArtifactSourceRefsGuard, createOwnedArtifactSourceRefsGuard } from './artifactSourceRefsGuards';

const user = { id: 'collab' } as never;

beforeEach(() => vi.clearAllMocks());

describe('createOwnedArtifactSourceRefsGuard', () => {
  it("accepts a session the user owns and rejects another user's session", async () => {
    mocks.sessionFindById.mockResolvedValueOnce({ userId: 'owner' });
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { sessionId: 's1' })).resolves.toBeUndefined();

    mocks.sessionFindById.mockResolvedValueOnce({ userId: 'someone-else' });
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { sessionId: 's2' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('createArtifactSourceRefsGuard', () => {
  it('accepts an update-shared session and asks for the global-write arm', async () => {
    mocks.findUpdateAccessById.mockResolvedValueOnce({ id: 's1' });

    await expect(createArtifactSourceRefsGuard(user)('collab', { sessionId: 's1' })).resolves.toBeUndefined();
    expect(mocks.findUpdateAccessById).toHaveBeenCalledWith(user, 's1', { includeGlobalWrite: true });
  });

  it('rejects a session without update access', async () => {
    mocks.findUpdateAccessById.mockResolvedValueOnce(null);

    await expect(createArtifactSourceRefsGuard(user)('collab', { sessionId: 's1' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
