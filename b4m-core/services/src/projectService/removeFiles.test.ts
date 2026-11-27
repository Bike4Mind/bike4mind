import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenError, InviteType, IUserDocument, NotFoundError, Permission } from '@bike4mind/common';
import { removeFiles } from './removeFiles';
import { applyUserSharesChange } from '../__tests__/utils/shareableFake';

/**
 * Detaching a file drops only the rows this project minted on it; direct shares are separate untagged
 * rows and are never re-created from invite history.
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

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    project = { id: PROJECT_ID, userId: OWNER_ID, fileIds: [FILE_ID], users: [] };
    file = { id: FILE_ID, userId: OWNER_ID, users: [] };

    db = {
      users: {
        findById: vi.fn(async (id: string) => asUser(id)),
        findByIds: vi.fn(async (ids: string[]) => ids.map(id => asUser(id))),
        findUserIdsByGroupIds: vi.fn(async () => ({})),
      },
      projects: {
        shareable: { findAccessibleById: vi.fn(async () => project) },
        update: vi.fn(async () => project),
        findParticipatingReferencing: vi.fn(async () => []),
      },
      fabFiles: {
        shareable: {
          findAllAccessibleByIds: vi.fn(async () => [file]),
          updateUserShares: vi.fn(async (_id: string, change: never) => applyUserSharesChange(file, change)),
        },
        findExistingIdsByIds: vi.fn(async () => []),
        findExistingIdsIncludingDeletedByIds: vi.fn(async () => []),
        findAllByIds: vi.fn(async (ids: string[]) => (ids.includes(file.id) ? [structuredClone(file)] : [])),
        updateGuarded: vi.fn(async (write: { id: string; users: unknown[] }) => {
          Object.assign(file, write);
          return file;
        }),
        update: vi.fn(),
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
    expect(db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      fileIds: [FILE_ID],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('accepts an uppercase hex id, which resolves the same row', async () => {
    // isObjectIdOrHexString accepts either case and Mongo resolves both to the same document, but
    // the resolved doc's `id` is always canonical lowercase. Comparing raw strings rejected a
    // request that worked before the set comparison landed.
    const UPPER = FILE_ID_HEX.toUpperCase();
    project.fileIds = [FILE_ID_HEX];
    file.id = FILE_ID_HEX;
    file.users = [{ userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID }];

    await removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [UPPER] }, { db });

    // Asserting the file is GONE, not merely that the call returned: a case-sensitive filter
    // answered 200 having removed nothing, which a status-only assertion happily accepts.
    expect(project.fileIds).toEqual([]);
    expect(file.users).toEqual([]);
    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      fileIds: [],
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('still rejects a castable id that did not resolve, which is an access failure', async () => {
    const UNREACHABLE_ID = '67dbe18a7f9cf1fa5d968600';
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);

    await expect(removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [UNREACHABLE_ID] }, { db })).rejects.toThrow(
      'Some files are not accessible'
    );
  });

  it('rejects with a ForbiddenError when a non-owner removes a file they do not own', async () => {
    project.userId = 'someone-else';
    file.userId = 'someone-else';

    await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it('drops a user whose only access to the file came from this project', async () => {
    file.users = [{ userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID }];

    await call();

    expect(file.users).toEqual([]);
  });

  it('does not re-create a direct grant from an accepted invite once the direct row is gone', async () => {
    file.users = [{ userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID }];
    db.invites.findAllByDocumentId = vi.fn(async () => [
      {
        type: InviteType.FabFile,
        permissions: [Permission.read, Permission.update, Permission.share],
        recipients: { pending: [], accepted: ['member@x.com'], refused: [] },
      },
    ]);
    db.users.findByIds = vi.fn(async () => [asUser('member-1', 'member@x.com')]);

    await call();

    expect(file.users).toEqual([]);
    expect(db.invites.findAllByDocumentId).not.toHaveBeenCalled();
  });

  it("keeps a member's untagged direct row while dropping the project's row", async () => {
    file.users = [
      { userId: 'member-1', permissions: [Permission.read, Permission.update], projectId: PROJECT_ID },
      { userId: 'member-1', permissions: [Permission.read] },
    ];

    await call();

    expect(file.users).toEqual([{ userId: 'member-1', permissions: [Permission.read] }]);
  });

  it('leaves an entry unrelated to this project untouched', async () => {
    file.users = [{ userId: 'other-project-member', permissions: [Permission.read], projectId: 'a-different-project' }];

    await call();

    expect(file.users).toEqual([
      { userId: 'other-project-member', permissions: [Permission.read], projectId: 'a-different-project' },
    ]);
  });

  it('answers NotFoundError for an unknown user or an inaccessible project', async () => {
    db.users.findById.mockResolvedValueOnce(null);
    await expect(call()).rejects.toBeInstanceOf(NotFoundError);

    db.projects.shareable.findAccessibleById.mockResolvedValueOnce(null);
    await expect(call()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers ForbiddenError when a non-owner removes a file they do not own', async () => {
    await expect(removeFiles('member-1', { projectId: PROJECT_ID, fileIds: [FILE_ID] }, { db })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(db.projects.update).not.toHaveBeenCalled();
  });

  it('lets the owner clear a held id that no longer resolves, such as a deleted file', async () => {
    project.fileIds = [FILE_ID_HEX];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);

    const { removedIds } = await removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [FILE_ID_HEX] }, { db });

    expect(removedIds).toEqual([FILE_ID_HEX]);
    expect(db.projects.update).toHaveBeenCalledWith(expect.objectContaining({ fileIds: [] }));
  });

  it('refuses the owner a held id whose file still exists but is unreadable, so no grant is left behind', async () => {
    project.fileIds = [FILE_ID_HEX];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);
    db.fabFiles.findExistingIdsByIds = vi.fn(async () => [FILE_ID_HEX]);

    await expect(removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [FILE_ID_HEX] }, { db })).rejects.toThrow(
      'Some files are not accessible'
    );
    expect(db.projects.update).not.toHaveBeenCalled();
  });

  it('still rejects a held id that no longer resolves for a member who is not the owner', async () => {
    project.fileIds = [FILE_ID_HEX];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);

    await expect(removeFiles('member-1', { projectId: PROJECT_ID, fileIds: [FILE_ID_HEX] }, { db })).rejects.toThrow(
      'Some files are not accessible'
    );
    expect(db.projects.update).not.toHaveBeenCalled();
  });

  it('reports no removed ids when the file is not in the project', async () => {
    project.fileIds = [];

    const { removedIds } = await call();

    expect(removedIds).toEqual([]);
  });

  it('revokes the project grants on a soft-deleted held file as well as clearing its id', async () => {
    project.fileIds = [FILE_ID_HEX];
    file.id = FILE_ID_HEX;
    file.deletedAt = new Date('2025-12-01');
    file.users = [{ userId: 'member-1', permissions: [Permission.read], projectId: PROJECT_ID }];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);
    db.fabFiles.findExistingIdsIncludingDeletedByIds = vi.fn(async () => [FILE_ID_HEX]);

    const { removedIds } = await removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [FILE_ID_HEX] }, { db });

    expect(removedIds).toEqual([FILE_ID_HEX]);
    expect(file.users).toEqual([]);
    expect(file.deletedAt).toEqual(new Date('2025-12-01'));
    expect(db.fabFiles.updateGuarded).toHaveBeenCalledWith({ id: FILE_ID_HEX, users: [] }, { includeDeleted: true });
    expect(db.projects.update).toHaveBeenCalledWith(expect.objectContaining({ fileIds: [] }));
  });

  it('clears a hard-deleted held file id without any revoke', async () => {
    project.fileIds = [FILE_ID_HEX];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);

    await removeFiles(OWNER_ID, { projectId: PROJECT_ID, fileIds: [FILE_ID_HEX] }, { db });

    expect(db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
    expect(db.projects.update).toHaveBeenCalledWith(expect.objectContaining({ fileIds: [] }));
  });

  it('refuses a non-owner a legacy non-ObjectId entry listed in the project', async () => {
    project.fileIds = ['legacy-entry'];
    db.fabFiles.shareable.findAllAccessibleByIds = vi.fn(async () => []);

    await expect(
      removeFiles('member-1', { projectId: PROJECT_ID, fileIds: ['legacy-entry'] }, { db })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.projects.update).not.toHaveBeenCalled();
  });

  it('still lets a non-owner remove a readable file they own', async () => {
    file.userId = 'member-1';

    const { removedIds } = await removeFiles('member-1', { projectId: PROJECT_ID, fileIds: [FILE_ID] }, { db });

    expect(removedIds).toEqual([FILE_ID]);
    expect(db.projects.update).toHaveBeenCalledWith(expect.objectContaining({ fileIds: [] }));
  });

  it('does not write the project or revoke anything when nothing is removed', async () => {
    project.fileIds = [];

    await call();

    expect(db.projects.update).not.toHaveBeenCalled();
    expect(db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
  });
});
