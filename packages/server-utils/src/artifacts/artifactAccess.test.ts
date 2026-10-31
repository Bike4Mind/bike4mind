import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUpdateAccessById, questFindById, artifactFindOne } = vi.hoisted(() => ({
  findUpdateAccessById: vi.fn(),
  questFindById: vi.fn(),
  artifactFindOne: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  artifactContentRepository: {},
  artifactRepository: { findOne: artifactFindOne },
  artifactVersionRepository: {},
  questRepository: { findById: questFindById },
  sessionRepository: { shareable: { findUpdateAccessById } },
}));

import { artifactSourceRefDeps } from './artifactAccess';

// The session arm includes global-write shares, which is the whole point of the third argument;
// a mutation dropping it stays green without this pin.
type User = Parameters<typeof artifactSourceRefDeps>[0];

const deps = (user = { id: 'u1' } as unknown as User) => artifactSourceRefDeps(user);

beforeEach(() => {
  vi.clearAllMocks();
  findUpdateAccessById.mockResolvedValue(null);
  questFindById.mockResolvedValue(null);
  artifactFindOne.mockResolvedValue(null);
});

describe('artifactSourceRefDeps', () => {
  it('grants session access through the update predicate, including global-write shares', async () => {
    const user = { id: 'u1' } as unknown as User;
    findUpdateAccessById.mockResolvedValue({ id: 's1' });

    await expect(deps(user).canUpdateSession('s1')).resolves.toBe(true);
    expect(findUpdateAccessById).toHaveBeenCalledWith(user, 's1', { includeGlobalWrite: true });
  });

  it('reports no session access when the lookup finds nothing', async () => {
    await expect(deps().canUpdateSession('s1')).resolves.toBe(false);
  });

  it('resolves a quest to its session, or null when the quest is missing', async () => {
    questFindById.mockResolvedValueOnce({ sessionId: 's1' });
    await expect(deps().getQuestSessionId('q1')).resolves.toBe('s1');

    await expect(deps().getQuestSessionId('q1')).resolves.toBeNull();
    expect(questFindById).toHaveBeenLastCalledWith('q1');
  });

  it('resolves an artifact to its owner, or null when the artifact is missing', async () => {
    artifactFindOne.mockResolvedValueOnce({ userId: 'u9' });
    await expect(deps().getArtifactOwner('a1')).resolves.toBe('u9');

    await expect(deps().getArtifactOwner('a1')).resolves.toBeNull();
    expect(artifactFindOne).toHaveBeenLastCalledWith({ id: 'a1' });
  });
});
