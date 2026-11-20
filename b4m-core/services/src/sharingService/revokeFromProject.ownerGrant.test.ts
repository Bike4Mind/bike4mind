import { describe, it, expect, vi } from 'vitest';
import { revokeFromProject } from './revoke';

type Row = { userId: string; permissions: string[]; projectId?: string };
type Doc = { id: string; userId: string; users: Row[] };

// In-memory stand-ins for the shareable repositories: a doc is readable by its owner or by a user
// holding a read/write row, which is what findAccessibleById checks.
const store = (docs: Doc[]) => {
  const byId = new Map(docs.map(d => [d.id, structuredClone(d)]));
  return {
    byId,
    repo: {
      findAllByIds: vi.fn(async (ids: string[]) => ids.map(id => byId.get(id)).filter(Boolean)),
      shareable: {
        findAccessibleById: vi.fn(async (user: { id: string }, id: string) => {
          const doc = byId.get(id);
          const readable =
            doc &&
            (doc.userId === user.id ||
              doc.users.some(u => u.userId === user.id && u.permissions.some(p => p === 'read' || p === 'write')));
          return readable ? structuredClone(doc) : null;
        }),
      },
      updateGuarded: vi.fn(async (write: Partial<Doc> & { id: string }) => {
        byId.set(write.id, { ...byId.get(write.id)!, ...write });
      }),
    },
  };
};

const P = 'project-1';
const grant = (userId: string): Row => ({ userId, permissions: ['read', 'update'], projectId: P });

const setup = () => {
  const files = store([
    { id: 'member-file', userId: 'member', users: [grant('owner'), grant('other')] },
    { id: 'owner-file', userId: 'owner', users: [grant('member'), grant('other')] },
  ]);
  const sessions = store([{ id: 'member-session', userId: 'member', users: [grant('owner'), grant('other')] }]);
  const adapters = {
    db: {
      fabFiles: files.repo,
      sessions: sessions.repo,
      projects: {},
      users: { findById: vi.fn(async (id: string) => ({ id, groups: [] })) },
    },
  };
  // leaveProject filters the leaver out of project.users before the cascade runs.
  const project = {
    id: P,
    userId: 'owner',
    users: [{ userId: 'other', permissions: ['read', 'update'] }],
    fileIds: ['member-file', 'owner-file'],
    sessionIds: ['member-session'],
  };
  return { files, sessions, adapters, project };
};

const holders = (doc: Doc | undefined) => (doc?.users ?? []).map(u => u.userId).sort();

describe('revokeFromProject - the owner grant on a departing member documents', () => {
  it("revokes the owner's grant on the leaver's files and sessions, not only the other members'", async () => {
    const { files, sessions, adapters, project } = setup();

    const pruned = await revokeFromProject({ project, userIdToRevoke: 'member' } as never, adapters as never);

    expect(holders(files.byId.get('member-file'))).toEqual([]);
    expect(holders(sessions.byId.get('member-session'))).toEqual([]);
    // The leaver loses their grant on the owner's file; the remaining member keeps theirs.
    expect(holders(files.byId.get('owner-file'))).toEqual(['other']);
    expect(pruned).toEqual({ fileIds: ['owner-file'], sessionIds: [] });
  });

  it('keeps going past a member it cannot reach, and still drops the file from the project', async () => {
    const { files, adapters, project } = setup();
    // An update-only row is invisible to findAccessibleById, so revoking it 404s. That used to abort
    // the whole file: the rows after it stayed and the file was never pruned from the project.
    files.byId.get('member-file')!.users[1].permissions = ['update'];

    const pruned = await revokeFromProject({ project, userIdToRevoke: 'member' } as never, adapters as never);

    expect(holders(files.byId.get('member-file'))).toEqual(['other']);
    expect(pruned.fileIds).toEqual(['owner-file']);
  });
});
