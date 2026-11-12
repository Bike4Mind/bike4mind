import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IUserDocument, storageOwnerOf } from '@bike4mind/common';
import { reassignMemberContent } from './reassignMemberContent';

const owner = { id: 'owner1', isAdmin: false } as IUserDocument;
const org = () => ({
  id: 'org1',
  userId: 'owner1',
  name: 'Acme',
  adminUserIds: [] as string[],
  users: [{ userId: 'member1' }, { userId: 'member2' }],
});

const writable = (modified = 1) => ({ updateMany: vi.fn().mockResolvedValue({ modifiedCount: modified }) });

const makeAdapters = () => ({
  db: {
    organizations: { findById: vi.fn().mockResolvedValue(org()) },
    groups: { findByOrganization: vi.fn().mockResolvedValue([{ id: 'g1' }]) },
    fabFiles: writable(2),
    artifacts: writable(1),
    projects: { ...writable(1), find: vi.fn().mockResolvedValue([{ id: 'p1', sessionIds: ['s-in-project'] }]) },
    sessions: writable(3),
    agents: writable(1),
  },
});

let adapters: ReturnType<typeof makeAdapters>;

beforeEach(() => {
  adapters = makeAdapters();
});

const run = (reassignTo = 'member2', userId = 'member1', actor = owner) =>
  reassignMemberContent(actor, { id: 'org1', userId, reassignTo }, adapters);

describe('reassignMemberContent', () => {
  it('moves each in-scope type to the target and reports what moved', async () => {
    await expect(run()).resolves.toEqual({ files: 2, artifacts: 1, projects: 1, notebooks: 3, agents: 1 });
  });

  it('uses the inventory scope server-side and only rewrites userId', async () => {
    await run();
    const { db } = adapters;
    const to = { userId: 'member2' };
    const stamped = { userId: 'member1', organizationId: 'org1', deletedAt: null };

    expect(db.fabFiles.updateMany).toHaveBeenCalledWith(stamped, to);
    expect(db.artifacts.updateMany).toHaveBeenCalledWith(stamped, to);
    expect(db.projects.updateMany).toHaveBeenCalledWith(
      { userId: 'member1', deletedAt: null, 'groups.groupId': { $in: ['g1'] } },
      to
    );
    expect(db.sessions.updateMany).toHaveBeenCalledWith(
      {
        userId: 'member1',
        deletedAt: null,
        $or: [{ 'groups.groupId': { $in: ['g1'] } }, { _id: { $in: ['s-in-project'] } }],
      },
      to
    );
    expect(db.agents.updateMany).toHaveBeenCalledWith(
      {
        userId: 'member1',
        organizationId: null,
        deletedAt: null,
        $or: [{ 'groups.groupId': { $in: ['g1'] } }, { projectId: { $in: ['p1'] } }],
      },
      to
    );
  });

  it('moves only org-billed files, so no personal storage counter changes', async () => {
    await run();
    const [filter] = adapters.db.fabFiles.updateMany.mock.calls[0];

    expect(filter.organizationId).toBe('org1');
    const before = { userId: 'member1', organizationId: filter.organizationId };
    expect(storageOwnerOf(before)).toEqual(storageOwnerOf({ ...before, userId: 'member2' }));
    expect(storageOwnerOf(before)).toEqual({ type: 'org', id: 'org1' });
  });

  it('accepts the billing owner as the target', async () => {
    await expect(run('owner1')).resolves.toMatchObject({ files: 2 });
  });

  it('only moves stamped files and artifacts when the org has no groups or projects', async () => {
    adapters.db.groups.findByOrganization.mockResolvedValue([]);

    const counts = await run();

    expect(counts).toEqual({ files: 2, artifacts: 1, projects: 0, notebooks: 0, agents: 0 });
    expect(adapters.db.projects.updateMany).not.toHaveBeenCalled();
    expect(adapters.db.sessions.updateMany).not.toHaveBeenCalled();
    expect(adapters.db.agents.updateMany).not.toHaveBeenCalled();
  });

  it('reports zero on a re-run once nothing is left to move', async () => {
    for (const repo of [adapters.db.fabFiles, adapters.db.artifacts, adapters.db.projects, adapters.db.sessions]) {
      repo.updateMany.mockResolvedValue({ modifiedCount: 0 });
    }
    adapters.db.agents.updateMany.mockResolvedValue({ modifiedCount: 0 });

    await expect(run()).resolves.toEqual({ files: 0, artifacts: 0, projects: 0, notebooks: 0, agents: 0 });
  });

  it('refuses the departing member, a non-member or an empty target before writing', async () => {
    await expect(run('member1')).rejects.toThrow('member being removed');
    await expect(run('pending-or-stranger')).rejects.toThrow('current member');
    await expect(run('')).rejects.toThrow();
    expect(adapters.db.fabFiles.updateMany).not.toHaveBeenCalled();
  });

  it('applies the removal gate: an outsider reads as not-found', async () => {
    await expect(run('member2', 'member1', { id: 'outsider', isAdmin: false } as IUserDocument)).rejects.toThrow(
      'Organization not found'
    );
    expect(adapters.db.fabFiles.updateMany).not.toHaveBeenCalled();
  });
});
