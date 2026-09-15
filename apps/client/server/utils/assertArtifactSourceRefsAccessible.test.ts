import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@server/utils/errors';
import { assertArtifactSourceRefsAccessible, type ArtifactRefAccessDeps } from './assertArtifactSourceRefsAccessible';

const OWNER = 'user-1';

function deps(overrides: Partial<ArtifactRefAccessDeps> = {}): ArtifactRefAccessDeps {
  return {
    // Default: the caller may write everything.
    canUpdateSession: vi.fn(async () => true),
    getQuestSessionId: vi.fn(async () => 'quest-session'),
    getArtifactOwner: vi.fn(async () => OWNER),
    ...overrides,
  };
}

describe('assertArtifactSourceRefsAccessible', () => {
  it('passes when no refs are supplied, and checks nothing', async () => {
    const d = deps();
    await expect(assertArtifactSourceRefsAccessible(OWNER, {}, d)).resolves.toBeUndefined();
    expect(d.canUpdateSession).not.toHaveBeenCalled();
    expect(d.getQuestSessionId).not.toHaveBeenCalled();
    expect(d.getArtifactOwner).not.toHaveBeenCalled();
  });

  it('passes when every supplied ref is writable, checking each ref against its own id', async () => {
    const d = deps();
    await expect(
      assertArtifactSourceRefsAccessible(OWNER, { sessionId: 's1', sourceQuestId: 'q1', parentArtifactId: 'a1' }, d)
    ).resolves.toBeUndefined();
    // Pin the exact ids so a swapped-argument regression fails here.
    expect(d.canUpdateSession).toHaveBeenCalledWith('s1');
    expect(d.getQuestSessionId).toHaveBeenCalledWith('q1');
    expect(d.getArtifactOwner).toHaveBeenCalledWith('a1');
  });

  it('passes for a session shared with update access (write access, not ownership)', async () => {
    // A collaborator with update access to a shared session creates artifacts stamped with the
    // owner's sessionId; access is granted though the caller does not own the session.
    const d = deps({ canUpdateSession: vi.fn(async () => true) });
    await expect(
      assertArtifactSourceRefsAccessible(OWNER, { sessionId: 'shared-with-me' }, d)
    ).resolves.toBeUndefined();
    expect(d.canUpdateSession).toHaveBeenCalledWith('shared-with-me');
  });

  it('rejects a sessionId the caller cannot write', async () => {
    const d = deps({ canUpdateSession: vi.fn(async () => false) });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { sessionId: 'someone-elses' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('checks a quest against its resolved session id, not the quest id', async () => {
    // The invariant the util warns about: access is transitive through the quest's session, so the
    // session check must run against getQuestSessionId's result, never the raw quest id.
    const canUpdateSession = vi.fn(async () => true);
    const d = deps({ getQuestSessionId: vi.fn(async () => 'resolved-session'), canUpdateSession });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { sourceQuestId: 'q-raw' }, d)).resolves.toBeUndefined();
    expect(d.getQuestSessionId).toHaveBeenCalledWith('q-raw');
    expect(canUpdateSession).toHaveBeenCalledWith('resolved-session');
    expect(canUpdateSession).not.toHaveBeenCalledWith('q-raw');
  });

  it('rejects a sourceQuestId whose session the caller cannot write', async () => {
    const d = deps({
      getQuestSessionId: vi.fn(async () => 'session-not-writable'),
      canUpdateSession: vi.fn(async () => false),
    });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { sourceQuestId: 'q-other' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it('rejects a sourceQuestId that does not exist (no session resolved)', async () => {
    const canUpdateSession = vi.fn(async () => true);
    const d = deps({ getQuestSessionId: vi.fn(async () => null), canUpdateSession });
    await expect(assertArtifactSourceRefsAccessible(OWNER, { sourceQuestId: 'ghost' }, d)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    // A missing quest must reject outright, never fall through to a session check on a null id.
    expect(canUpdateSession).not.toHaveBeenCalled();
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
