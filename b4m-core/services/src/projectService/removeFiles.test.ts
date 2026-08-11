import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InviteType, IUserDocument } from '@bike4mind/common';
import { removeFiles } from './removeFiles';

/**
 * IUserShare tracks a single projectId, so a user who is both a project member AND holds a
 * separately-accepted direct invite for the same file could not otherwise be told apart from
 * one whose only access came from the project - a bot review on #1151 found that the
 * pushShareable merge fix there makes this reachable via either accept ordering, where before
 * it depended on which grant happened first. These tests pin the fix: keep (with projectId
 * cleared) an entry backed by an accepted direct invite; drop a project-only entry entirely.
 */
describe('projectService - removeFiles (project-derived access revocation)', () => {
  const OWNER_ID = 'owner-1';
  const PROJECT_ID = 'project-1';
  const FILE_ID = 'file-1';

  const asUser = (id: string) => ({ id, username: 'u', isAdmin: false }) as IUserDocument;

  let db: any;
  let project: any;
  let file: any;

  beforeEach(() => {
    project = { id: PROJECT_ID, userId: OWNER_ID, fileIds: [FILE_ID], users: [] };
    file = { id: FILE_ID, userId: OWNER_ID, users: [] };

    db = {
      users: {
        findById: vi.fn(async (id: string) => asUser(id)),
      },
      projects: {
        shareable: { findAccessibleById: vi.fn(async () => project) },
        update: vi.fn(async () => project),
      },
      fabFiles: {
        shareable: { findAllAccessibleByIds: vi.fn(async () => [file]) },
        update: vi.fn(async () => file),
      },
      invites: {
        findAllByDocumentId: vi.fn(async () => []),
      },
    };
  });

  const call = () => removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [FILE_ID] }, { db });

  it('drops a user whose only access to the file came from this project', async () => {
    file.users = [{ userId: 'member-1', permissions: ['read'], projectId: PROJECT_ID }];

    await call();

    expect(file.users).toEqual([]);
    expect(db.invites.findAllByDocumentId).toHaveBeenCalledWith(FILE_ID);
  });

  it('keeps a project member who also holds an accepted direct invite, clearing only projectId', async () => {
    file.users = [{ userId: 'member-1', permissions: ['read', 'share'], projectId: PROJECT_ID }];
    db.users.findById = vi.fn(async () => ({ ...asUser('member-1'), email: 'member@x.com' }));
    db.invites.findAllByDocumentId = vi.fn(async () => [
      { type: InviteType.FabFile, recipients: { pending: [], accepted: ['member@x.com'], refused: [] } },
    ]);

    await call();

    expect(file.users).toEqual([{ userId: 'member-1', permissions: ['read', 'share'], projectId: undefined }]);
  });

  it('leaves an entry unrelated to this project untouched', async () => {
    file.users = [{ userId: 'other-project-member', permissions: ['read'], projectId: 'a-different-project' }];

    await call();

    expect(file.users).toEqual([
      { userId: 'other-project-member', permissions: ['read'], projectId: 'a-different-project' },
    ]);
  });

  it('skips the invite lookup entirely when no entry is project-derived (common case)', async () => {
    file.users = [{ userId: 'other-project-member', permissions: ['read'], projectId: 'a-different-project' }];

    await call();

    expect(db.invites.findAllByDocumentId).not.toHaveBeenCalled();
    // findById is still called once for the caller (OWNER_ID); it must not ALSO be
    // called to resolve the unrelated file.users entry's email.
    expect(db.users.findById).toHaveBeenCalledTimes(1);
    expect(db.users.findById).toHaveBeenCalledWith(OWNER_ID);
  });

  it('only counts an accepted invite of type FabFile, not an unrelated invite for the same document id', async () => {
    file.users = [{ userId: 'member-1', permissions: ['read'], projectId: PROJECT_ID }];
    db.users.findById = vi.fn(async () => ({ ...asUser('member-1'), email: 'member@x.com' }));
    // Same documentId, but a Session-type invite - must not be mistaken for a FabFile share.
    db.invites.findAllByDocumentId = vi.fn(async () => [
      { type: InviteType.Session, recipients: { pending: [], accepted: ['member@x.com'], refused: [] } },
    ]);

    await call();

    expect(file.users).toEqual([]);
  });
});
