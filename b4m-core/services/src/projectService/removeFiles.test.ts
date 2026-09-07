import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InviteType, IUserDocument, Permission } from '@bike4mind/common';
import { removeFiles } from './removeFiles';

/**
 * IUserShare tracks a single projectId, so a user who is both a project member AND holds a
 * separately-accepted direct invite for the same file could not otherwise be told apart from
 * one whose only access came from the project - a bot review on #1151 found that the
 * pushShareable merge fix there makes this reachable via either accept ordering, where before
 * it depended on which grant happened first. A human reviewer then found the first pass of this
 * fix kept the FULL merged permission set (project-derived permissions included) rather than
 * resetting to what the independent direct invite itself grants, and that the per-entry
 * `users.findById` inside this loop is unmemoized inside the route's transaction. These tests
 * pin all three: drop a project-only entry entirely; for one with an accepted direct invite,
 * clear projectId AND reset permissions to just the direct invite's own grant; resolve grantee
 * emails via one batched `findByIds` call, not one per entry.
 */
describe('projectService - removeFiles (project-derived access revocation)', () => {
  const OWNER_ID = 'owner-1';
  const PROJECT_ID = 'project-1';
  const FILE_ID = 'file-1';
  // A real hex id, needed by the case-normalisation test below.
  const FILE_ID_HEX = '67dbe18a7f9cf1fa5d968600';

  const asUser = (id: string, email?: string) => ({ id, username: 'u', isAdmin: false, email }) as IUserDocument;

  let db: any;
  let project: any;
  let file: any;

  beforeEach(() => {
    project = { id: PROJECT_ID, userId: OWNER_ID, fileIds: [FILE_ID], users: [] };
    file = { id: FILE_ID, userId: OWNER_ID, users: [] };

    db = {
      users: {
        findById: vi.fn(async (id: string) => asUser(id)),
        findByIds: vi.fn(async (ids: string[]) => ids.map(id => asUser(id))),
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

  it('removes an id that cannot address a row instead of rejecting the request', async () => {
    // The read guards skip such an entry rather than throwing, so rejecting here made a legacy
    // id unremovable: it stayed in the project and warned on every read.
    const JUNK_ID = 'legacy-uuid-not-an-objectid';
    project.fileIds = [FILE_ID, JUNK_ID];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);

    await removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [JUNK_ID] }, { db });

    expect(project.fileIds).toEqual([FILE_ID]);
    expect(db.projects.update).toHaveBeenCalled();
  });

  it('accepts an uppercase hex id, which resolves the same row', async () => {
    // isObjectIdOrHexString accepts either case and Mongo resolves both to the same document, but
    // the resolved doc's `id` is always canonical lowercase. Comparing raw strings rejected a
    // request that worked before the set comparison landed.
    const UPPER = FILE_ID_HEX.toUpperCase();
    project.fileIds = [FILE_ID_HEX];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => [
      { id: FILE_ID_HEX, userId: OWNER_ID, users: [] },
    ]);

    await removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [UPPER] }, { db });

    // Asserting the file is GONE, not merely that the call returned: a case-sensitive filter
    // answered 200 having removed nothing, which a status-only assertion happily accepts.
    expect(project.fileIds).toEqual([]);
    expect(db.projects.update).toHaveBeenCalled();
  });

  it('still rejects a castable id that did not resolve, which is an access failure', async () => {
    const UNREACHABLE_ID = '67dbe18a7f9cf1fa5d968600';
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);

    await expect(removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [UNREACHABLE_ID] }, { db })).rejects.toThrow(
      'Some files are not accessible'
    );
  });

  it('drops a user whose only access to the file came from this project', async () => {
    file.users = [{ userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID }];

    await call();

    expect(file.users).toEqual([]);
    expect(db.invites.findAllByDocumentId).toHaveBeenCalledWith(FILE_ID);
  });

  it('keeps a project member with an accepted direct invite, resetting to the direct grant only', async () => {
    // Project granted [read, update, share] (via pushShareable's union); the direct invite
    // only ever granted [read, share] - the update permission must NOT survive the revoke.
    file.users = [
      {
        userId: 'member-1',
        permissions: [Permission.read, Permission.update, Permission.share],
        projectId: PROJECT_ID,
      },
    ];
    db.users.findByIds = vi.fn(async () => [asUser('member-1', 'member@x.com')]);
    db.invites.findAllByDocumentId = vi.fn(async () => [
      {
        type: InviteType.FabFile,
        permissions: [Permission.read, Permission.share],
        recipients: { pending: [], accepted: ['member@x.com'], refused: [] },
      },
    ]);

    await call();

    expect(file.users).toEqual([
      { userId: 'member-1', permissions: [Permission.read, Permission.share], projectId: undefined },
    ]);
  });

  it('unions permissions across more than one accepted direct invite for the same recipient', async () => {
    file.users = [{ userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID }];
    db.users.findByIds = vi.fn(async () => [asUser('member-1', 'member@x.com')]);
    db.invites.findAllByDocumentId = vi.fn(async () => [
      {
        type: InviteType.FabFile,
        permissions: [Permission.read],
        recipients: { pending: [], accepted: ['member@x.com'], refused: [] },
      },
      {
        type: InviteType.FabFile,
        permissions: [Permission.share],
        recipients: { pending: [], accepted: ['member@x.com'], refused: [] },
      },
    ]);

    await call();

    expect(file.users[0].permissions).toEqual(expect.arrayContaining([Permission.read, Permission.share]));
    expect(file.users[0].permissions).toHaveLength(2);
  });

  it('leaves an entry unrelated to this project untouched', async () => {
    file.users = [{ userId: 'other-project-member', permissions: [Permission.read], projectId: 'a-different-project' }];

    await call();

    expect(file.users).toEqual([
      { userId: 'other-project-member', permissions: [Permission.read], projectId: 'a-different-project' },
    ]);
  });

  it('skips the invite lookup and the batched user lookup when no entry is project-derived (common case)', async () => {
    file.users = [{ userId: 'other-project-member', permissions: [Permission.read], projectId: 'a-different-project' }];

    await call();

    expect(db.invites.findAllByDocumentId).not.toHaveBeenCalled();
    expect(db.users.findByIds).not.toHaveBeenCalled();
  });

  it('only counts an accepted invite of type FabFile, not an unrelated invite for the same document id', async () => {
    file.users = [{ userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID }];
    db.users.findByIds = vi.fn(async () => [asUser('member-1', 'member@x.com')]);
    // Same documentId, but a Session-type invite - must not be mistaken for a FabFile share.
    db.invites.findAllByDocumentId = vi.fn(async () => [
      {
        type: InviteType.Session,
        permissions: [Permission.read],
        recipients: { pending: [], accepted: ['member@x.com'], refused: [] },
      },
    ]);

    await call();

    expect(file.users).toEqual([]);
  });

  it('resolves grantee emails with one batched findByIds call, not one findById per project-member entry', async () => {
    file.users = [
      { userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID },
      { userId: 'member-2', permissions: [Permission.read], projectId: PROJECT_ID },
    ];
    db.invites.findAllByDocumentId = vi.fn(async () => [
      {
        type: InviteType.FabFile,
        permissions: [Permission.read],
        recipients: { pending: [], accepted: [], refused: [] },
      },
    ]);

    await call();

    expect(db.users.findByIds).toHaveBeenCalledTimes(1);
    expect(db.users.findByIds).toHaveBeenCalledWith(expect.arrayContaining(['member-1', 'member-2']));
  });
});
