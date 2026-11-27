import { describe, it, expect, vi } from 'vitest';
import { BadRequestError, ForbiddenError, IUserDocument, Permission } from '@bike4mind/common';
import { addFiles } from './addFiles';
import { addSessions } from './addSessions';
import { addSystemPrompts } from './addSystemPrompts';
import { createProject } from './create';
import { removeSystemPrompts } from './removeSystemPrompts';
import { removeFiles } from './removeFiles';
import { canAttachToProject } from './attachGate';
import { createShareableFake, ShareableFakeDoc } from '../__tests__/utils/shareableFake';

// Project membership grants read on every attached item, so attaching is sharing: these pin that
// only an item's owner or a holder of share on it can attach it, on every attach door.
const OWNER = 'user-owner';
const ADDER = 'user-adder';
const MEMBER = 'user-member';
const STRANGER = 'user-stranger';

type Row = { userId: string; permissions: Permission[]; projectId?: string };
type Item = ShareableFakeDoc & { users: Row[]; groups: Array<{ groupId: string; permissions: Permission[] }> };

const item = (id: string, userId: string, users: Row[] = [], groups: Item['groups'] = []): Item => ({
  id,
  userId,
  users,
  groups,
});

const adder = (groups: string[] = []) => ({ id: ADDER, groups }) as unknown as IUserDocument;

const projectFor = (overrides: Partial<{ fileIds: string[]; sessionIds: string[] }> = {}) => ({
  id: 'project-1',
  userId: OWNER,
  fileIds: [] as string[],
  sessionIds: [] as string[],
  systemPrompts: [] as Array<{ fileId: string; enabled: boolean }>,
  users: [
    { userId: ADDER, permissions: [Permission.read, Permission.update] },
    { userId: MEMBER, permissions: [Permission.read] },
  ],
  groups: [],
  ...overrides,
});

const adaptersFor = (project: ReturnType<typeof projectFor>, files: Item[], sessions: Item[] = []) => {
  const projectUpdate = vi.fn(async () => ({}));
  const fileShares = createShareableFake(files);
  const sessionShares = createShareableFake(sessions);
  return {
    projectUpdate,
    fileShares,
    sessionShares,
    adapters: {
      db: {
        projects: {
          shareable: createShareableFake([project as never]),
          updateWithUpdateAccess: projectUpdate,
          create: vi.fn(async (doc: object) => ({ id: 'project-new', ...doc })),
        },
        fabFiles: { shareable: fileShares },
        sessions: { shareable: sessionShares },
      },
    },
  };
};

const memberGrant = (doc: Item) => doc.users.find(row => row.userId === MEMBER && row.projectId === 'project-1');

describe('canAttachToProject', () => {
  it('allows the owner and a share holder (direct or via group), refuses read/update-only holders', () => {
    expect(canAttachToProject(item('f', ADDER), adder())).toBe(true);
    expect(canAttachToProject(item('f', OWNER, [{ userId: ADDER, permissions: [Permission.share] }]), adder())).toBe(
      true
    );
    expect(
      canAttachToProject(item('f', OWNER, [], [{ groupId: 'g1', permissions: [Permission.share] }]), adder(['g1']))
    ).toBe(true);
    expect(
      canAttachToProject(
        item('f', OWNER, [{ userId: ADDER, permissions: [Permission.read, Permission.update] }]),
        adder()
      )
    ).toBe(false);
  });

  it('exempts an item already attached to the project, matching hex ids case-insensitively', () => {
    const readOnly = item('aaaaaaaaaaaaaaaaaaaaaaaa', OWNER, [{ userId: ADDER, permissions: [Permission.read] }]);
    expect(canAttachToProject(readOnly, adder(), ['AAAAAAAAAAAAAAAAAAAAAAAA'])).toBe(true);
  });
});

describe('addFiles share gate', () => {
  it('refuses a file the adder can only read, writing nothing and granting nothing', async () => {
    const file = item('file-1', OWNER, [{ userId: ADDER, permissions: [Permission.read, Permission.update] }]);
    const project = projectFor();
    const { adapters, projectUpdate, fileShares } = adaptersFor(project, [file]);

    await expect(addFiles(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never)).rejects.toThrow(
      ForbiddenError
    );
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(fileShares.updateUserShares).not.toHaveBeenCalled();
    expect(memberGrant(file)).toBeUndefined();
  });

  it("still answers 400 for another user's file the adder cannot read at all", async () => {
    const file = item('file-1', STRANGER);
    const { adapters, projectUpdate } = adaptersFor(projectFor(), [file]);

    await expect(addFiles(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never)).rejects.toThrow(
      BadRequestError
    );
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('refuses the whole batch when one file is not shareable', async () => {
    const own = item('file-own', ADDER);
    const readOnly = item('file-ro', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const { adapters, projectUpdate } = adaptersFor(projectFor(), [own, readOnly]);

    await expect(
      addFiles(adder(), { projectId: 'project-1', fileIds: ['file-own', 'file-ro'] }, adapters as never)
    ).rejects.toThrow(ForbiddenError);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('lets a share holder attach, granting members read capped at what the adder holds', async () => {
    const file = item('file-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read, Permission.share] }]);
    const { adapters, projectUpdate } = adaptersFor(projectFor(), [file]);

    const result = await addFiles(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never);

    expect(result.fileIds).toEqual(['file-1']);
    expect(projectUpdate).toHaveBeenCalled();
    expect(memberGrant(file)?.permissions).toEqual([Permission.read]);
  });

  it('lets a read-only holder re-send a file the project already holds', async () => {
    const file = item('file-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const { adapters } = adaptersFor(projectFor({ fileIds: ['file-1'] }), [file]);

    const result = await addFiles(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never);
    expect(result.fileIds).toEqual(['file-1']);
  });

  it('lets a read-only holder add a file the project already holds as a system prompt', async () => {
    const file = item('file-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const project = { ...projectFor(), systemPrompts: [{ fileId: 'file-1', enabled: true }] };
    const { adapters } = adaptersFor(project, [file]);

    const result = await addFiles(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never);
    expect(result.fileIds).toEqual(['file-1']);
  });

  it('names only the refused files in the error', async () => {
    const own = { ...item('file-own', ADDER), fileName: 'mine.txt' };
    const readOnly = {
      ...item('file-ro', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]),
      fileName: 'theirs.txt',
    };
    const { adapters } = adaptersFor(projectFor(), [own, readOnly]);

    const error = await addFiles(
      adder(),
      { projectId: 'project-1', fileIds: ['file-own', 'file-ro'] },
      adapters as never
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toContain('theirs.txt');
    expect((error as Error).message).not.toContain('mine.txt');
  });
});

describe('addSystemPrompts share gate', () => {
  it('refuses a file the adder can only read', async () => {
    const file = item('file-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const { adapters, projectUpdate } = adaptersFor(projectFor(), [file]);

    await expect(
      addSystemPrompts(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never)
    ).rejects.toThrow(ForbiddenError);
    expect(projectUpdate).not.toHaveBeenCalled();
  });

  it('allows a read-only file that is already one of the project files', async () => {
    const file = item('file-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const { adapters } = adaptersFor(projectFor({ fileIds: ['file-1'] }), [file]);

    const result = await addSystemPrompts(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never);
    expect(result.systemPrompts).toEqual([{ fileId: 'file-1', enabled: true }]);
  });

  it('allows a file the adder owns', async () => {
    const file = item('file-1', ADDER);
    const { adapters } = adaptersFor(projectFor(), [file]);

    const result = await addSystemPrompts(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never);
    expect(result.systemPrompts).toEqual([{ fileId: 'file-1', enabled: true }]);
    expect(memberGrant(file)?.permissions).toEqual([Permission.read]);
  });
});

describe('addSessions share gate', () => {
  it('refuses a notebook the adder can only read', async () => {
    const session = item('session-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read, Permission.update] }]);
    const { adapters, projectUpdate, sessionShares } = adaptersFor(projectFor(), [], [session]);

    await expect(
      addSessions(adder(), { projectId: 'project-1', sessionIds: ['session-1'] }, adapters as never)
    ).rejects.toThrow(ForbiddenError);
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(sessionShares.updateUserShares).not.toHaveBeenCalled();
  });

  it('attaches an owned notebook but leaves out knowledge files the adder can only read', async () => {
    const ownFile = item('file-own', ADDER);
    const readOnlyFile = item('file-ro', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const session = { ...item('session-1', ADDER), knowledgeIds: ['file-own', 'file-ro'] };
    const project = projectFor();
    const { adapters, projectUpdate } = adaptersFor(project, [ownFile, readOnlyFile], [session]);

    await addSessions(adder(), { projectId: 'project-1', sessionIds: ['session-1'] }, adapters as never);

    expect(projectUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionIds: ['session-1'], fileIds: ['file-own'] })
    );
    expect(memberGrant(ownFile)).toBeDefined();
    expect(memberGrant(readOnlyFile)).toBeUndefined();
  });
});

describe('createProject share gate', () => {
  it('refuses initial files or notebooks the creator can only read', async () => {
    const file = item('file-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const session = item('session-1', STRANGER, [{ userId: ADDER, permissions: [Permission.read] }]);
    const { adapters } = adaptersFor(projectFor(), [file], [session]);

    await expect(
      createProject(adder(), { name: 'p', fileIds: ['file-1'] } as never, adapters as never)
    ).rejects.toThrow(ForbiddenError);
    await expect(
      createProject(adder(), { name: 'p', sessionIds: ['session-1'] } as never, adapters as never)
    ).rejects.toThrow(ForbiddenError);
    expect(adapters.db.projects.create).not.toHaveBeenCalled();
  });

  it('creates a project with items the creator owns or can share', async () => {
    const own = item('file-own', ADDER);
    const shared = item('file-shared', STRANGER, [{ userId: ADDER, permissions: [Permission.read, Permission.share] }]);
    const { adapters } = adaptersFor(projectFor(), [own, shared]);

    const project = await createProject(
      adder(),
      { name: 'p', fileIds: ['file-own', 'file-shared'] } as never,
      adapters as never
    );
    expect(project.fileIds).toEqual(['file-own', 'file-shared']);
  });
});

describe('removeSystemPrompts revokes project grants', () => {
  const setup = (overrides: Partial<{ fileIds: string[] }> = {}) => {
    const file = item('file-1', OWNER, [
      { userId: MEMBER, permissions: [Permission.read], projectId: 'project-1' },
      { userId: MEMBER, permissions: [Permission.read], projectId: 'project-2' },
      { userId: STRANGER, permissions: [Permission.read] },
    ]);
    const project = { ...projectFor(overrides), userId: ADDER, systemPrompts: [{ fileId: 'file-1', enabled: true }] };
    const fileShares = createShareableFake([file]);
    const adapters = {
      db: {
        projects: {
          shareable: createShareableFake([project as never]),
          update: vi.fn(async () => ({})),
          findParticipatingReferencing: vi.fn(async () => []),
        },
        fabFiles: {
          shareable: fileShares,
          findAllByIds: vi.fn(async (ids: string[]) => [file].filter(f => ids.includes(f.id))),
          updateGuarded: vi.fn(async (write: { id: string; users?: Row[] }) => {
            if (write.id === file.id && write.users) file.users = write.users;
            return file;
          }),
        },
        users: {
          findByIds: vi.fn(async () => []),
          findById: vi.fn(async (id: string) => ({ id, groups: [] })),
          findUserIdsByGroupIds: vi.fn(async () => ({})),
        },
        invites: { findAllByDocumentId: vi.fn(async () => []) },
      },
    };
    return { file, adapters };
  };

  it("drops this project's grants on the removed prompt file, keeping other projects' and direct grants", async () => {
    const { file, adapters } = setup();

    await removeSystemPrompts(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never);

    expect(memberGrant(file)).toBeUndefined();
    expect(file.users).toEqual([
      { userId: MEMBER, permissions: [Permission.read], projectId: 'project-2' },
      { userId: STRANGER, permissions: [Permission.read] },
    ]);
  });

  it('keeps the grants when the file is still one of the project files', async () => {
    const { file, adapters } = setup({ fileIds: ['file-1'] });

    await removeSystemPrompts(adder(), { projectId: 'project-1', fileIds: ['file-1'] }, adapters as never);

    expect(memberGrant(file)).toBeDefined();
    expect(adapters.db.fabFiles.shareable.updateUserShares).not.toHaveBeenCalled();
  });

  it('revokes nothing when no prompt matched', async () => {
    const { file, adapters } = setup();

    await removeSystemPrompts(adder(), { projectId: 'project-1', fileIds: ['file-other'] }, adapters as never);

    expect(memberGrant(file)).toBeDefined();
    expect(adapters.db.fabFiles.findAllByIds).not.toHaveBeenCalled();
  });
});

describe('removeFiles keeps grants on a file still attached as a system prompt', () => {
  it('takes the file out of fileIds without revoking its project grants', async () => {
    const file = item('file-1', OWNER, [{ userId: MEMBER, permissions: [Permission.read], projectId: 'project-1' }]);
    const project = { ...projectFor({ fileIds: ['file-1'] }), systemPrompts: [{ fileId: 'file-1', enabled: true }] };
    const fileShares = createShareableFake([file]);
    const db = {
      users: { findById: vi.fn(async (id: string) => ({ id })), findByIds: vi.fn(async () => []) },
      projects: { shareable: createShareableFake([project as never]), update: vi.fn(async () => project) },
      fabFiles: {
        shareable: fileShares,
        findExistingIdsByIds: vi.fn(async () => []),
        findExistingIdsIncludingDeletedByIds: vi.fn(async () => []),
      },
      invites: { findAllByDocumentId: vi.fn(async () => []) },
    };

    const { removedIds } = await removeFiles(OWNER, { projectId: 'project-1', fileIds: ['file-1'] }, { db } as never);

    expect(removedIds).toEqual(['file-1']);
    expect(fileShares.updateUserShares).not.toHaveBeenCalled();
    expect(memberGrant(file)).toBeDefined();
  });
});
