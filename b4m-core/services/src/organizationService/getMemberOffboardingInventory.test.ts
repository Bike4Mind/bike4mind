import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyStatus, CreditHolderType, IUserDocument } from '@bike4mind/common';
import { getMemberOffboardingInventory, OFFBOARDING_SAMPLE_LIMIT } from './getMemberOffboardingInventory';

const owner = { id: 'owner1', isAdmin: false } as IUserDocument;
const org = () => ({
  id: 'org1',
  userId: 'owner1',
  name: 'Acme',
  adminUserIds: [] as string[],
  users: [{ userId: 'member1' }, { userId: 'member2' }],
});

const repo = <T extends { id: string }>(docs: T[] = [], total = docs.length) => ({
  find: vi.fn().mockResolvedValue(docs),
  count: vi.fn().mockResolvedValue(total),
});

const makeAdapters = () => ({
  db: {
    organizations: { findById: vi.fn().mockResolvedValue(org()) },
    groups: { findByOrganization: vi.fn().mockResolvedValue([{ id: 'g1' }]) },
    fabFiles: repo([{ id: 'f1', fileName: 'plan.pdf' }]),
    artifacts: repo([{ id: 'a1', title: 'Spec' }]),
    projects: repo([{ id: 'p1', name: 'Launch' }]),
    sessions: repo([{ id: 's1', name: 'Notes' }]),
    agents: repo([{ id: 'ag1', name: 'Helper' }]),
    userApiKeys: { count: vi.fn().mockResolvedValue(1) },
  },
});

let adapters: ReturnType<typeof makeAdapters>;

beforeEach(() => {
  adapters = makeAdapters();
});

const run = (userId = 'member1', actor = owner) =>
  getMemberOffboardingInventory(actor, { id: 'org1', userId }, adapters);

describe('getMemberOffboardingInventory', () => {
  it('lists the member org-context content and counts only their live org-billed keys', async () => {
    const inventory = await run();

    expect(inventory.files).toEqual({ count: 1, sample: [{ id: 'f1', name: 'plan.pdf' }] });
    expect(inventory.artifacts.sample).toEqual([{ id: 'a1', name: 'Spec' }]);
    expect(inventory.projects.count).toBe(1);
    expect(inventory.notebooks.count).toBe(1);
    expect(inventory.agents.count).toBe(1);
    expect(inventory.orgBilledApiKeys).toEqual({ count: 1 });
  });

  it('scopes every query to the member and the org', async () => {
    await run();
    const { db } = adapters;

    expect(db.fabFiles.find).toHaveBeenCalledWith(
      { userId: 'member1', organizationId: 'org1', deletedAt: null },
      expect.anything()
    );
    expect(db.artifacts.find).toHaveBeenCalledWith(
      { userId: 'member1', organizationId: 'org1', deletedAt: null },
      expect.anything()
    );
    expect(db.projects.find).toHaveBeenCalledWith(
      {
        userId: 'member1',
        deletedAt: null,
        'groups.groupId': { $in: ['g1'] },
      },
      expect.anything()
    );
    expect(db.sessions.find).toHaveBeenCalledWith(
      {
        userId: 'member1',
        deletedAt: null,
        'groups.groupId': { $in: ['g1'] },
      },
      expect.anything()
    );
    // Org-owned agents (organizationId set) are excluded; only member-owned ones are in scope. A
    // project's group share does not reach the notebooks or agents inside it.
    expect(db.agents.find).toHaveBeenCalledWith(
      {
        userId: 'member1',
        organizationId: null,
        deletedAt: null,
        'groups.groupId': { $in: ['g1'] },
      },
      expect.anything()
    );
  });

  it('skips the group-scoped queries for an org with no groups', async () => {
    adapters.db.groups.findByOrganization.mockResolvedValue([]);

    const inventory = await run();

    expect(adapters.db.projects.find).not.toHaveBeenCalled();
    expect(adapters.db.sessions.find).not.toHaveBeenCalled();
    expect(adapters.db.agents.find).not.toHaveBeenCalled();
    expect(inventory.projects).toEqual({ count: 0, sample: [] });
  });

  it('asks for a capped sample and counts separately', async () => {
    adapters.db.fabFiles.count.mockResolvedValue(30);

    const { files } = await run();

    expect(files.count).toBe(30);
    const filter = { userId: 'member1', organizationId: 'org1', deletedAt: null };
    expect(adapters.db.fabFiles.find).toHaveBeenCalledWith(filter, expect.objectContaining({ limit: 25 }));
    expect(adapters.db.fabFiles.count).toHaveBeenCalledWith(filter);
    expect(OFFBOARDING_SAMPLE_LIMIT).toBe(25);
  });

  it('counts only the member live org-billed non-embed keys, the set removal revokes', async () => {
    await run();

    expect(adapters.db.userApiKeys.count).toHaveBeenCalledWith({
      userId: 'member1',
      organizationId: 'org1',
      billingOwnerType: CreditHolderType.Organization,
      status: { $ne: ApiKeyStatus.DISABLED },
      agentId: null,
    });
  });

  it('reads as not-found for a non-member, a stranger, or a missing org', async () => {
    await expect(run('pending-or-stranger')).rejects.toThrow('Organization not found');
    await expect(run('member1', { id: 'outsider', isAdmin: false } as IUserDocument)).rejects.toThrow(
      'Organization not found'
    );
    adapters.db.organizations.findById.mockResolvedValue(null);
    await expect(run()).rejects.toThrow('Organization not found');
    expect(adapters.db.fabFiles.find).not.toHaveBeenCalled();
  });

  it('refuses the billing owner as a target', async () => {
    await expect(run('owner1')).rejects.toThrow('organization owner');
  });

  it('refuses a manager target for a non-owner manager', async () => {
    adapters.db.organizations.findById.mockResolvedValue({ ...org(), adminUserIds: ['member1', 'member2'] });

    await expect(run('member2', { id: 'member1', isAdmin: false } as IUserDocument)).rejects.toThrow(
      'Only the organization owner'
    );
  });
});
