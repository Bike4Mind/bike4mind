import { describe, it, expect, vi } from 'vitest';
import { revoke, revokeFromProject } from './revoke';

type Row = { userId: string; permissions: string[]; projectId?: string; sessionId?: string };
type Doc = { id: string; userId: string; users: Row[]; groups?: []; knowledgeIds?: string[] };
type Project = {
  id: string;
  userId: string;
  users: Row[];
  fileIds: string[];
  sessionIds: string[];
  systemPrompts: { fileId: string; enabled: boolean }[];
};

const readable = (doc: Doc | Project, userId: string) =>
  doc.userId === userId || doc.users.some(u => u.userId === userId && u.permissions.some(p => p === 'read'));

// In-memory shareable repository with the read predicate findAccessibleById applies.
const store = <T extends Doc>(docs: T[]) => {
  const byId = new Map(docs.map(d => [d.id, structuredClone(d)]));
  return {
    byId,
    repo: {
      findAllByIds: vi.fn(async (ids: string[]) => ids.map(id => byId.get(id)).filter(Boolean)),
      find: vi.fn(async (filter: { users: { $elemMatch: { userId: string; sessionId: string } } }) => {
        const { userId, sessionId } = filter.users.$elemMatch;
        return [...byId.values()]
          .filter(d => d.users.some(u => u.userId === userId && u.sessionId === sessionId))
          .map(d => structuredClone(d));
      }),
      shareable: {
        findAccessibleById: vi.fn(async (user: { id: string }, id: string) => {
          const doc = byId.get(id);
          return doc && readable(doc, user.id) ? structuredClone(doc) : null;
        }),
      },
      updateGuarded: vi.fn(async (write: Partial<T> & { id: string }) => {
        byId.set(write.id, { ...byId.get(write.id)!, ...write });
      }),
    },
  };
};

const projectStore = (projects: Project[]) => {
  const byId = new Map(projects.map(p => [p.id, structuredClone(p)]));
  return {
    byId,
    repo: {
      shareable: {
        findAllAccessible: vi.fn(async (user: { id: string }) =>
          [...byId.values()].filter(p => readable(p, user.id)).map(p => structuredClone(p))
        ),
      },
      pullFileReferences: vi.fn(async (fileIds: string[], scope: { projectId: string }) => {
        const p = byId.get(scope.projectId)!;
        p.fileIds = p.fileIds.filter(id => !fileIds.includes(id));
        p.systemPrompts = p.systemPrompts.filter(prompt => !fileIds.includes(prompt.fileId));
      }),
      update: vi.fn(async (write: Partial<Project> & { id: string }) => {
        byId.set(write.id, { ...byId.get(write.id)!, ...write });
      }),
    },
  };
};

const adaptersFor = (files: Doc[], sessions: Doc[] = [], projects: Project[] = []) => {
  const f = store(files);
  const s = store(sessions);
  const p = projectStore(projects);
  const onAccessRemoved = vi.fn();
  return {
    files: f.byId,
    sessions: s.byId,
    projects: p.byId,
    onAccessRemoved,
    adapters: {
      db: {
        fabFiles: f.repo,
        sessions: s.repo,
        projects: p.repo,
        users: { findById: vi.fn(async (id: string) => ({ id, groups: [] })) },
      },
      onAccessRemoved,
    } as never,
  };
};

const project = (overrides: Partial<Project>): Project => ({
  id: 'project-1',
  userId: 'sharee',
  users: [],
  fileIds: [],
  sessionIds: [],
  systemPrompts: [],
  ...overrides,
});

describe('revoke - residual grants', () => {
  it('lets the owner remove a grant that carries share but not read', async () => {
    const env = adaptersFor([
      { id: 'file-1', userId: 'owner', users: [{ userId: 'planted', permissions: ['share'] }] },
    ]);

    await revoke('owner', { id: 'file-1', type: 'files', userId: 'planted' }, env.adapters);

    expect(env.files.get('file-1')!.users).toEqual([]);
  });

  it('still refuses a stranger revoking a share-only grant', async () => {
    const env = adaptersFor([
      { id: 'file-1', userId: 'owner', users: [{ userId: 'planted', permissions: ['share'] }] },
    ]);

    await expect(
      revoke('stranger', { id: 'file-1', type: 'files', userId: 'planted' }, env.adapters)
    ).rejects.toThrow();
    expect(env.files.get('file-1')!.users).toHaveLength(1);
  });

  it('drops the rows a session minted on a file detached from it before the revoke', async () => {
    const env = adaptersFor(
      [
        {
          id: 'detached',
          userId: 'owner',
          users: [
            { userId: 'sharee', permissions: ['read', 'update'], sessionId: 'session-1' },
            { userId: 'sharee', permissions: ['read'] },
          ],
        },
      ],
      [
        {
          id: 'session-1',
          userId: 'owner',
          knowledgeIds: [],
          users: [{ userId: 'sharee', permissions: ['read', 'update'] }],
        },
      ]
    );

    await revoke('owner', { id: 'session-1', type: 'sessions', userId: 'sharee' }, env.adapters);

    expect(env.files.get('detached')!.users).toEqual([{ userId: 'sharee', permissions: ['read'] }]);
  });

  describe('projects holding the item', () => {
    const sharedFile = (extra: Row[] = []): Doc => ({
      id: 'file-1',
      userId: 'owner',
      users: [
        { userId: 'sharee', permissions: ['read', 'share'] },
        { userId: 'sharee', permissions: ['read', 'update'], projectId: 'project-1' },
        { userId: 'member', permissions: ['read'], projectId: 'project-1' },
        ...extra,
      ],
    });
    const memberRow = { userId: 'member', permissions: ['read'] };

    it("detaches the item from the revoked user's project and drops every row that project minted", async () => {
      const env = adaptersFor([sharedFile()], [], [project({ users: [memberRow], fileIds: ['file-1'] })]);

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.files.get('file-1')!.users).toEqual([]);
      expect(env.projects.get('project-1')!.fileIds).toEqual([]);
      expect(env.onAccessRemoved).toHaveBeenCalledWith(expect.arrayContaining(['sharee', 'member']));
    });

    it('detaches a system-prompt file the same way', async () => {
      const env = adaptersFor(
        [sharedFile()],
        [],
        [project({ users: [memberRow], systemPrompts: [{ fileId: 'file-1', enabled: true }] })]
      );

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.systemPrompts).toEqual([]);
      expect(env.files.get('file-1')!.users).toEqual([]);
    });

    it('keeps the item when the owner takes part in the project', async () => {
      const env = adaptersFor(
        [sharedFile()],
        [],
        [project({ users: [memberRow, { userId: 'owner', permissions: ['read'] }], fileIds: ['file-1'] })]
      );

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual(['file-1']);
      expect(env.files.get('file-1')!.users).toContainEqual({
        userId: 'member',
        permissions: ['read'],
        projectId: 'project-1',
      });
    });

    it('keeps the item when another participant still holds share on it directly', async () => {
      const env = adaptersFor(
        [sharedFile([{ userId: 'member', permissions: ['read', 'share'] }])],
        [],
        [project({ users: [memberRow], fileIds: ['file-1'] })]
      );

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual(['file-1']);
    });

    it('does not count share minted by the project itself as a grantor', async () => {
      const env = adaptersFor(
        [sharedFile([{ userId: 'member', permissions: ['read', 'share'], projectId: 'project-1' }])],
        [],
        [project({ users: [memberRow], fileIds: ['file-1'] })]
      );

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual([]);
    });

    it('detaches a session from the project the same way', async () => {
      const env = adaptersFor(
        [],
        [
          {
            id: 'session-1',
            userId: 'owner',
            knowledgeIds: [],
            users: [
              { userId: 'sharee', permissions: ['read', 'share'] },
              { userId: 'member', permissions: ['read'], projectId: 'project-1' },
            ],
          },
        ],
        [project({ users: [memberRow], sessionIds: ['session-1'] })]
      );

      await revoke('owner', { id: 'session-1', type: 'sessions', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.sessionIds).toEqual([]);
      expect(env.sessions.get('session-1')!.users).toEqual([]);
    });
  });
});

describe('revokeFromProject - system-prompt files', () => {
  it("revokes the leaver's grant on a file attached only as a system prompt", async () => {
    const env = adaptersFor([
      {
        id: 'prompt-file',
        userId: 'owner',
        users: [{ userId: 'member', permissions: ['read', 'update'], projectId: 'project-1' }],
      },
    ]);
    const p = project({ userId: 'owner', systemPrompts: [{ fileId: 'prompt-file', enabled: true }] });

    await revokeFromProject({ project: p as never, userIdToRevoke: 'member' }, env.adapters);

    expect(env.files.get('prompt-file')!.users).toEqual([]);
  });

  it("drops the others' grants on the leaver's own prompt file and prunes it from the project", async () => {
    const env = adaptersFor([
      {
        id: 'prompt-file',
        userId: 'member',
        users: [{ userId: 'owner', permissions: ['read', 'update'], projectId: 'project-1' }],
      },
    ]);
    const p = project({ userId: 'owner', systemPrompts: [{ fileId: 'prompt-file', enabled: true }] });

    const pruned = await revokeFromProject({ project: p as never, userIdToRevoke: 'member' }, env.adapters);

    expect(env.files.get('prompt-file')!.users).toEqual([]);
    expect(pruned.systemPrompts).toEqual([]);
  });
});
