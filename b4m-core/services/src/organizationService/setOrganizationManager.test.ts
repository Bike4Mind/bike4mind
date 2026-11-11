import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setOrganizationManager } from './setOrganizationManager';
import { IOrganizationDocument, IUserDocument, Permission } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

describe('organizationService - setOrganizationManager', () => {
  const owner = { id: 'owner1', isAdmin: false } as IUserDocument;
  const manager = { id: 'admin1', isAdmin: false } as IUserDocument;
  const platformAdmin = { id: 'staff1', isAdmin: true } as IUserDocument;

  const freshOrg = (over: Partial<IOrganizationDocument> = {}) =>
    ({
      id: 'org1',
      userId: 'owner1',
      personal: false,
      users: [
        { userId: 'admin1', permissions: [Permission.read] },
        { userId: 'user2', permissions: [Permission.read] },
        { userId: 'norights', permissions: [] },
      ],
      adminUserIds: ['admin1'],
      ...over,
    }) as IOrganizationDocument;

  let org: IOrganizationDocument;

  const buildAdapters = () => ({
    db: {
      organizations: {
        findById: vi.fn(async (): Promise<IOrganizationDocument | null> => org),
        addAdmin: vi.fn(async (_orgId: string, userId: string) => {
          org = { ...org, adminUserIds: [...org.adminUserIds, userId] } as IOrganizationDocument;
          return true;
        }),
        removeAdmin: vi.fn(async (_orgId: string, userId: string) => {
          org = { ...org, adminUserIds: org.adminUserIds.filter(id => id !== userId) } as IOrganizationDocument;
        }),
      },
    },
  });
  let adapters: ReturnType<typeof buildAdapters>;

  beforeEach(() => {
    org = freshOrg();
    adapters = buildAdapters();
  });

  const run = (actor: IUserDocument, userId: string, isManager: boolean) =>
    setOrganizationManager(actor, { organizationId: 'org1', userId, isManager }, adapters);

  it('appoints a member through the targeted write and reports both lists', async () => {
    const change = await run(owner, 'user2', true);

    expect(adapters.db.organizations.addAdmin).toHaveBeenCalledWith('org1', 'user2');
    expect(change.previousAdminUserIds).toEqual(['admin1']);
    expect(change.adminUserIds).toEqual(['admin1', 'user2']);
  });

  it('removes a manager through the targeted write', async () => {
    const change = await run(owner, 'admin1', false);

    expect(adapters.db.organizations.removeAdmin).toHaveBeenCalledWith('org1', 'admin1');
    expect(change.adminUserIds).toEqual([]);
  });

  it('lets a platform admin act', async () => {
    await expect(run(platformAdmin, 'user2', true)).resolves.toBeDefined();
  });

  it('refuses a manager with the same answer as a missing org', async () => {
    await expect(run(manager, 'user2', true)).rejects.toBeInstanceOf(NotFoundError);
    expect(adapters.db.organizations.addAdmin).not.toHaveBeenCalled();
  });

  it('refuses a missing org', async () => {
    adapters.db.organizations.findById.mockResolvedValueOnce(null);
    await expect(run(owner, 'user2', true)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses the owner as a target', async () => {
    await expect(run(owner, 'owner1', true)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses a personal organization', async () => {
    org = freshOrg({ personal: true });
    await expect(run(owner, 'user2', true)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses to appoint an outsider or a row that confers no membership', async () => {
    await expect(run(owner, 'outsider', true)).rejects.toBeInstanceOf(BadRequestError);
    await expect(run(owner, 'norights', true)).rejects.toBeInstanceOf(BadRequestError);
    expect(adapters.db.organizations.addAdmin).not.toHaveBeenCalled();
  });

  it('refuses when the member was removed between the read and the write', async () => {
    adapters.db.organizations.addAdmin.mockResolvedValueOnce(false);
    await expect(run(owner, 'user2', true)).rejects.toBeInstanceOf(BadRequestError);
  });
});
