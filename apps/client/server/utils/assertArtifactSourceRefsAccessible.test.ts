import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@server/utils/errors';
import { assertArtifactSourceRefsAccessible, type ArtifactRefAccessDeps } from './assertArtifactSourceRefsAccessible';

const OWNER = 'user-1';

function deps(overrides: Partial<ArtifactRefAccessDeps> = {}): ArtifactRefAccessDeps {
  return {
    // Default: the caller can access everything.
    isAccessibleSession: vi.fn(async () => true),
    getQuestSessionId: vi.fn(async () => 'session-accessible'),
    getArtifactOwner: vi.fn(async () => OWNER),
    ...overrides,
  };
}

describe('assertArtifactSourceRefsAccessible', () => {
  it('passes when no refs are supplied (nothing to check)', async () => {
    const d = deps();
    await expect(assertArtifactSourceRefsAccessible(OWNER, {}, d)).resolves.toBeUndefined();
    expect(d.isAccessibleSession).not.toHaveBeenCalled();
  });

  it('passes when every supplied ref is accessible', async () => {
    await expect(
      assertArtifactSourceRefsAccessible(
        OWNER,
        { sessionId: 's1', sourceQuestId: 'q1', parentArtifactId: 'a1' },
        deps()
      )
    ).resolves.toBeUndefined();
  });

  it('passes for a session shared with the caller (access, not ownership)', async () => {
    // A collaborator in a session the owner shared with them creates artifacts stamped with the
    // owner's sessionId; access is granted though the caller does not own the session.
    const d = deps({ isAccessibleSession: vi.fn(async () => true) });
    await expect(
      assertArtifactSourceRefsAccessible(OWNER, { sessionId: 'shared-with-me' }, d)
    ).resolves.toBeUndefined();
  });

  it('rejects a sessionId the caller cannot access', async () => {
    const d = deps({ isAccessibleSession: vi.fn(async () => false) });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { sessionId: 'someone-elses' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a sourceQuestId whose session the caller cannot access', async () => {
    const d = deps({
      getQuestSessionId: vi.fn(async () => 'session-not-accessible'),
      isAccessibleSession: vi.fn(async () => false),
    });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { sourceQuestId: 'q-other' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a sourceQuestId that does not exist', async () => {
    const d = deps({ getQuestSessionId: vi.fn(async () => null) });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { sourceQuestId: 'ghost' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a parentArtifactId owned by another user (artifacts are not shareable)', async () => {
    const d = deps({ getArtifactOwner: vi.fn(async () => 'user-2') });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { parentArtifactId: 'a-other' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a parentArtifactId that does not exist', async () => {
    const d = deps({ getArtifactOwner: vi.fn(async () => null) });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { parentArtifactId: 'ghost' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });
});
