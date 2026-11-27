import { describe, it, expect, vi } from 'vitest';
import { revoke, revokeFromProject } from './revoke';

type Row = { userId: string; permissions: string[]; projectId?: string; sessionId?: string };
type Doc = {
  id: string;
  userId: string;
  users: Row[];
  groups?: { groupId: string; permissions: string[] }[];
  knowledgeIds?: string[];
};
type Project = {
  id: string;
  userId: string;
  users: Row[];
  fileIds: string[];
  sessionIds: string[];
  systemPrompts: { fileId: string; enabled: boolean }[];
  groups?: { groupId: string; permissions: string[] }[];
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
      findSharingGrantFilesBySession: vi.fn(async (sessionId: string, userId?: string) =>
        [...byId.values()]
          .filter(document =>
            document.users.some(row => row.sessionId === sessionId && (!userId || row.userId === userId))
          )
          .map(document => structuredClone(document))
      ),
      shareable: {
        findAccessibleById: vi.fn(async (user: { id: string }, id: string) => {
          const doc = byId.get(id);
          return doc && readable(doc, user.id) ? structuredClone(doc) : null;
        }),
      },
      updateGuarded: vi.fn(async (write: Partial<T> & { id: string }) => {
        byId.set(write.id, { ...byId.get(write.id)!, ...write });
        return structuredClone(byId.get(write.id));
      }),
    },
  };
};

const projectStore = (projects: Project[]) => {
  const byId = new Map(projects.map(p => [p.id, structuredClone(p)]));
  return {
    byId,
    repo: {
      findParticipatingReferencing: vi.fn(async (user: { id: string }, ref: { fileId?: string; sessionId?: string }) =>
        [...byId.values()]
          .filter(p => readable(p, user.id))
          .filter(p =>
            ref.fileId
              ? p.fileIds.includes(ref.fileId) || p.systemPrompts.some(prompt => prompt.fileId === ref.fileId)
              : p.sessionIds.includes(ref.sessionId!)
          )
          .map(p => structuredClone(p))
      ),
      pullFileReferences: vi.fn(async (fileIds: string[], scope: { projectId: string }) => {
        const p = byId.get(scope.projectId)!;
        p.fileIds = p.fileIds.filter(id => !fileIds.includes(id));
        p.systemPrompts = p.systemPrompts.filter(prompt => !fileIds.includes(prompt.fileId));
      }),
      pullSessionReferences: vi.fn(async (sessionIds: string[], scope: { projectId: string }) => {
        const project = byId.get(scope.projectId)!;
        project.sessionIds = project.sessionIds.filter(id => !sessionIds.includes(id));
      }),
      update: vi.fn(async (write: Partial<Project> & { id: string }) => {
        byId.set(write.id, { ...byId.get(write.id)!, ...write });
      }),
    },
  };
};

const adaptersFor = (
  files: Doc[],
  sessions: Doc[] = [],
  projects: Project[] = [],
  groupsOf: Record<string, string[]> = {}
) => {
  const f = store(files);
  const s = store(sessions);
  const p = projectStore(projects);
  const onAccessRemoved = vi.fn();
  return {
    files: f.byId,
    sessions: s.byId,
    projects: p.byId,
    findReferencing: p.repo.findParticipatingReferencing,
    onAccessRemoved,
    adapters: {
      db: {
        fabFiles: f.repo,
        sessions: s.repo,
        projects: p.repo,
        users: {
          findById: vi.fn(async (id: string) => ({ id, groups: groupsOf[id] ?? [] })),
          findUserIdsByGroupIds: vi.fn(async (groupIds: string[]) =>
            Object.fromEntries(
              groupIds.map(groupId => [groupId, Object.keys(groupsOf).filter(id => groupsOf[id].includes(groupId))])
            )
          ),
        },
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
      expect(env.findReferencing).toHaveBeenCalledWith(expect.objectContaining({ id: 'sharee' }), { fileId: 'file-1' });
    });

    it("detaches the item from the user's own project when they revoke their own share", async () => {
      const env = adaptersFor([sharedFile()], [], [project({ users: [memberRow], fileIds: ['file-1'] })]);

      await revoke('sharee', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual([]);
      expect(env.files.get('file-1')!.users).toEqual([]);
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

    it('keeps the item when another participant holds share on it through a group', async () => {
      const file = { ...sharedFile(), groups: [{ groupId: 'g1', permissions: ['read', 'share'] }] };
      const env = adaptersFor(
        [file],
        [],
        [project({ userId: 'carol', users: [{ userId: 'sharee', permissions: ['read'] }], fileIds: ['file-1'] })],
        { carol: ['g1'] }
      );

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual(['file-1']);
    });

    it('keeps the item when the revoked project owner retains independent group share', async () => {
      const file = { ...sharedFile(), groups: [{ groupId: 'g1', permissions: ['read', 'share'] }] };
      const env = adaptersFor([file], [], [project({ users: [memberRow], fileIds: ['file-1'] })], { sharee: ['g1'] });

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual(['file-1']);
      expect(env.files.get('file-1')!.users).toEqual([
        { userId: 'member', permissions: ['read'], projectId: 'project-1' },
      ]);
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

    it('does not count share minted by another project as a grantor', async () => {
      const env = adaptersFor(
        [sharedFile([{ userId: 'member', permissions: ['read', 'share'], projectId: 'project-2' }])],
        [],
        [project({ users: [memberRow], fileIds: ['file-1'] })]
      );

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual([]);
    });

    it('keeps the item when a member of a group the project is shared with holds share on it', async () => {
      const env = adaptersFor(
        [sharedFile([{ userId: 'carol', permissions: ['read', 'share'] }])],
        [],
        [project({ users: [memberRow], fileIds: ['file-1'], groups: [{ groupId: 'team', permissions: ['read'] }] })],
        { carol: ['team'] }
      );

      await revoke('owner', { id: 'file-1', type: 'files', userId: 'sharee' }, env.adapters);

      expect(env.projects.get('project-1')!.fileIds).toEqual(['file-1']);
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

    describe("a detached session's knowledge files", () => {
      const session: Doc = {
        id: 'session-1',
        userId: 'owner',
        knowledgeIds: ['knowledge-1'],
        users: [
          { userId: 'sharee', permissions: ['read', 'share'] },
          { userId: 'member', permissions: ['read'], projectId: 'project-1' },
        ],
      };
      const knowledgeFile = (extra: Row[] = []): Doc => ({
        id: 'knowledge-1',
        userId: 'owner',
        users: [
          { userId: 'sharee', permissions: ['read', 'share'], sessionId: 'session-1' },
          { userId: 'member', permissions: ['read'], projectId: 'project-1' },
          ...extra,
        ],
      });
      const attached = project({ users: [memberRow], sessionIds: ['session-1'], fileIds: ['knowledge-1'] });

      it('leave the project with the session when no participant backs them', async () => {
        const env = adaptersFor([knowledgeFile()], [session], [attached]);

        await revoke('owner', { id: 'session-1', type: 'sessions', userId: 'sharee' }, env.adapters);

        expect(env.projects.get('project-1')!.sessionIds).toEqual([]);
        expect(env.projects.get('project-1')!.fileIds).toEqual([]);
        expect(env.files.get('knowledge-1')!.users).toEqual([]);
      });

      it('stay when another participant still holds share on them', async () => {
        const env = adaptersFor(
          [knowledgeFile([{ userId: 'member', permissions: ['read', 'share'] }])],
          [session],
          [attached]
        );

        await revoke('owner', { id: 'session-1', type: 'sessions', userId: 'sharee' }, env.adapters);

        expect(env.projects.get('project-1')!.sessionIds).toEqual([]);
        expect(env.projects.get('project-1')!.fileIds).toEqual(['knowledge-1']);
        expect(env.files.get('knowledge-1')!.users).toContainEqual({
          userId: 'member',
          permissions: ['read'],
          projectId: 'project-1',
        });
      });

      it('stay when the revokee still holds share on them outside the session', async () => {
        const env = adaptersFor(
          [knowledgeFile([{ userId: 'sharee', permissions: ['read', 'share'] }])],
          [session],
          [attached]
        );

        await revoke('owner', { id: 'session-1', type: 'sessions', userId: 'sharee' }, env.adapters);

        expect(env.projects.get('project-1')!.fileIds).toEqual(['knowledge-1']);
      });
    });
  });
});

describe('revoke - dependent project closure', () => {
  it.each([false, true])(
    'follows every lost file recipient after removing a session source (session attached: %s)',
    async sessionAttached => {
      const env = adaptersFor(
        [
          {
            id: 'file-1',
            userId: 'owner',
            users: [
              { userId: 'sharee', permissions: ['read', 'share'], sessionId: 'session-1' },
              { userId: 'member', permissions: ['read', 'share'], projectId: 'project-1' },
              { userId: 'downstream', permissions: ['read'], projectId: 'project-2' },
            ],
          },
        ],
        [
          {
            id: 'session-1',
            userId: 'owner',
            knowledgeIds: ['file-1'],
            users: [
              { userId: 'sharee', permissions: ['read', 'share'] },
              ...(sessionAttached ? [{ userId: 'member', permissions: ['read'], projectId: 'project-1' }] : []),
            ],
          },
        ],
        [
          project({
            users: [{ userId: 'member', permissions: ['read'] }],
            fileIds: ['file-1'],
            sessionIds: sessionAttached ? ['session-1'] : [],
          }),
          project({
            id: 'project-2',
            userId: 'member',
            users: [{ userId: 'downstream', permissions: ['read'] }],
            fileIds: ['file-1'],
          }),
        ]
      );

      await revoke('owner', { id: 'session-1', type: 'sessions', userId: 'sharee' }, env.adapters);

      expect(env.files.get('file-1')!.users).toEqual([]);
      expect(env.projects.get('project-1')!.fileIds).toEqual([]);
      expect(env.projects.get('project-2')!.fileIds).toEqual([]);
      expect(env.onAccessRemoved.mock.calls.flatMap(([ids]) => ids)).toContain('downstream');
    }
  );
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
