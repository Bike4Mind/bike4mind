import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';
import { assertArtifactSourceRefsOwned, type ArtifactRefOwnershipDeps } from './assertArtifactSourceRefsOwned';

const OWNER = 'user-1';

function deps(overrides: Partial<ArtifactRefOwnershipDeps> = {}): ArtifactRefOwnershipDeps {
  return {
    // Default: the owner owns everything.
    isOwnedSession: vi.fn(async (_id: string, uid: string) => uid === OWNER),
    getQuestSessionId: vi.fn(async () => 'session-owned-by-owner'),
    getArtifactOwner: vi.fn(async () => OWNER),
    ...overrides,
  };
}

describe('assertArtifactSourceRefsOwned', () => {
  it('passes when no refs are supplied (nothing to check)', async () => {
    const d = deps();
    await expect(assertArtifactSourceRefsOwned(OWNER, {}, d)).resolves.toBeUndefined();
    expect(d.isOwnedSession).not.toHaveBeenCalled();
  });

  it('passes when every supplied ref is owned', async () => {
    await expect(
      assertArtifactSourceRefsOwned(OWNER, { sessionId: 's1', sourceQuestId: 'q1', parentArtifactId: 'a1' }, deps())
    ).resolves.toBeUndefined();
  });

  it('rejects a sessionId the caller does not own', async () => {
    const d = deps({ isOwnedSession: vi.fn(async () => false) });
    await expect(assertArtifactSourceRefsOwned(OWNER, { sessionId: 'someone-elses' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a sourceQuestId whose session the caller does not own', async () => {
    const d = deps({
      getQuestSessionId: vi.fn(async () => 'session-owned-by-someone-else'),
      isOwnedSession: vi.fn(async () => false),
    });
    await expect(assertArtifactSourceRefsOwned(OWNER, { sourceQuestId: 'q-other' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a sourceQuestId that does not exist', async () => {
    const d = deps({ getQuestSessionId: vi.fn(async () => null) });
    await expect(assertArtifactSourceRefsOwned(OWNER, { sourceQuestId: 'ghost' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a parentArtifactId owned by another user', async () => {
    const d = deps({ getArtifactOwner: vi.fn(async () => 'user-2') });
    await expect(assertArtifactSourceRefsOwned(OWNER, { parentArtifactId: 'a-other' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a parentArtifactId that does not exist', async () => {
    const d = deps({ getArtifactOwner: vi.fn(async () => null) });
    await expect(assertArtifactSourceRefsOwned(OWNER, { parentArtifactId: 'ghost' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });
});
