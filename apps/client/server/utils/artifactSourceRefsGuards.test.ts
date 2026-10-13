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

import {
  createArtifactSourceRefsGuard,
  createLazyArtifactSourceRefsGuard,
  createOwnedArtifactSourceRefsGuard,
} from './artifactSourceRefsGuards';

const user = { id: 'collab' } as never;

beforeEach(() => vi.resetAllMocks());

describe('createOwnedArtifactSourceRefsGuard', () => {
  it('rejects a session that does not exist', async () => {
    mocks.sessionFindById.mockResolvedValueOnce(null);
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { sessionId: 'gone' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('resolves a quest through the session the user owns, and rejects one in a foreign session', async () => {
    mocks.questFindById.mockResolvedValue({ sessionId: 's1' });
    mocks.sessionFindById.mockResolvedValueOnce({ userId: 'owner' });
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { sourceQuestId: 'q1' })).resolves.toBeUndefined();

    mocks.sessionFindById.mockResolvedValueOnce({ userId: 'someone-else' });
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { sourceQuestId: 'q1' })).rejects.toMatchObject({
      statusCode: 403,
    });

    mocks.questFindById.mockResolvedValue(null);
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { sourceQuestId: 'q2' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('requires the parent artifact to belong to the user', async () => {
    mocks.artifactFindOne.mockResolvedValueOnce({ userId: 'owner' });
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { parentArtifactId: 'a1' })).resolves.toBeUndefined();

    mocks.artifactFindOne.mockResolvedValueOnce({ userId: 'someone-else' });
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { parentArtifactId: 'a1' })).rejects.toMatchObject({
      statusCode: 403,
    });

    mocks.artifactFindOne.mockResolvedValueOnce(null);
    await expect(createOwnedArtifactSourceRefsGuard()('owner', { parentArtifactId: 'a2' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('resolves without touching any repository when no refs are given', async () => {
    await expect(createOwnedArtifactSourceRefsGuard()('owner', {})).resolves.toBeUndefined();

    expect(mocks.sessionFindById).not.toHaveBeenCalled();
    expect(mocks.questFindById).not.toHaveBeenCalled();
    expect(mocks.artifactFindOne).not.toHaveBeenCalled();
  });

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

describe('createArtifactSourceRefsGuard - quest and parent refs', () => {
  it("accepts a quest whose session the actor can update, checking that quest's session", async () => {
    mocks.questFindById.mockResolvedValueOnce({ sessionId: 'quest-session' });
    mocks.findUpdateAccessById.mockResolvedValueOnce({ id: 'quest-session' });

    await expect(createArtifactSourceRefsGuard(user)('collab', { sourceQuestId: 'q1' })).resolves.toBeUndefined();
    expect(mocks.findUpdateAccessById).toHaveBeenCalledWith(user, 'quest-session', { includeGlobalWrite: true });
  });

  it('rejects a missing quest, naming the source quest', async () => {
    mocks.questFindById.mockResolvedValueOnce(null);

    await expect(createArtifactSourceRefsGuard(user)('collab', { sourceQuestId: 'q1' })).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('source quest'),
    });
  });

  it('rejects a quest whose session the actor cannot update', async () => {
    mocks.questFindById.mockResolvedValueOnce({ sessionId: 'quest-session' });
    mocks.findUpdateAccessById.mockResolvedValueOnce(null);

    await expect(createArtifactSourceRefsGuard(user)('collab', { sourceQuestId: 'q1' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('accepts a parent artifact the actor owns and rejects a foreign or missing one', async () => {
    mocks.artifactFindOne.mockResolvedValueOnce({ userId: 'collab' });
    await expect(createArtifactSourceRefsGuard(user)('collab', { parentArtifactId: 'a1' })).resolves.toBeUndefined();

    mocks.artifactFindOne.mockResolvedValueOnce({ userId: 'owner' });
    await expect(createArtifactSourceRefsGuard(user)('collab', { parentArtifactId: 'a1' })).rejects.toMatchObject({
      statusCode: 403,
    });

    mocks.artifactFindOne.mockResolvedValueOnce(null);
    await expect(createArtifactSourceRefsGuard(user)('collab', { parentArtifactId: 'a2' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('createLazyArtifactSourceRefsGuard', () => {
  it('loads the user once across sequential and concurrent calls', async () => {
    mocks.findUpdateAccessById.mockResolvedValue({ id: 's1' });
    const loadUser = vi.fn().mockResolvedValue(user);
    const guard = createLazyArtifactSourceRefsGuard(loadUser);

    await Promise.all([guard('collab', { sessionId: 's1' }), guard('collab', { sessionId: 's2' })]);
    await guard('collab', { sessionId: 's3' });
    await guard('collab', {});

    expect(loadUser).toHaveBeenCalledTimes(1);
    expect(loadUser).toHaveBeenCalledWith('collab');
  });

  it('refuses a call for a different user than the one loaded', async () => {
    mocks.findUpdateAccessById.mockResolvedValue({ id: 's1' });
    const loadUser = vi.fn().mockResolvedValue(user);
    const guard = createLazyArtifactSourceRefsGuard(loadUser);

    await guard('collab', { sessionId: 's1' });

    await expect(guard('other', { sessionId: 's1' })).rejects.toThrow('different user');
    expect(loadUser).toHaveBeenCalledTimes(1);
  });

  it('throws when the user is not found and retries the load on the next call', async () => {
    mocks.findUpdateAccessById.mockResolvedValue({ id: 's1' });
    const loadUser = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(user);
    const guard = createLazyArtifactSourceRefsGuard(loadUser);

    await expect(guard('collab', { sessionId: 's1' })).rejects.toThrow('Cannot persist artifact: user not found');
    await expect(guard('collab', { sessionId: 's1' })).resolves.toBeUndefined();

    expect(loadUser).toHaveBeenCalledTimes(2);
  });

  it('retries after the loader itself rejects', async () => {
    const loadUser = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(user);
    const guard = createLazyArtifactSourceRefsGuard(loadUser);

    await expect(guard('collab', {})).rejects.toThrow('db down');
    await expect(guard('collab', {})).resolves.toBeUndefined();
    expect(loadUser).toHaveBeenCalledTimes(2);
  });

  it('applies the real access check once the user is loaded', async () => {
    mocks.findUpdateAccessById.mockResolvedValueOnce(null);
    const guard = createLazyArtifactSourceRefsGuard(async () => user);

    await expect(guard('collab', { sessionId: 's1' })).rejects.toMatchObject({ statusCode: 403 });
  });
});
