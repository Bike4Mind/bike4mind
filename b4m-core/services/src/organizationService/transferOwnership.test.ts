import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transferOwnership } from './transferOwnership';
import { IOrganizationDocument, IUserDocument, Permission } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

describe('organizationService - transferOwnership', () => {
  const owner = { id: 'owner1', email: 'owner@example.com', name: 'Owner' } as IUserDocument;
  const admin = { id: 'admin1', email: 'admin@example.com', name: 'Admin' } as IUserDocument;
  const stranger = { id: 'user9', email: 'x@example.com', name: 'X', isAdmin: false } as IUserDocument;

  const freshOrg = (over: Partial<IOrganizationDocument> = {}) =>
    ({
      id: 'org1',
      userId: 'owner1',
      personal: false,
      billingContact: 'owner@example.com',
      stripeCustomerId: 'cus_1',
      users: [
        { userId: 'admin1', permissions: [Permission.read] },
        { userId: 'user2', permissions: [Permission.read] },
      ],
      adminUserIds: ['admin1'],
      ...over,
    }) as IOrganizationDocument;

  let org: IOrganizationDocument;
  let usersById: Record<string, IUserDocument | null>;

  const buildAdapters = () => ({
    db: {
      organizations: {
        findById: vi.fn(async (): Promise<IOrganizationDocument | null> => org),
        update: vi.fn(async (_input: Record<string, unknown>) => org),
        ensureUserDetails: vi.fn(async () => undefined),
      },
      users: { findById: vi.fn(async (id: string) => usersById[id] ?? null) },
    },
  });
  let adapters: ReturnType<typeof buildAdapters>;

  beforeEach(() => {
    org = freshOrg();
    usersById = { owner1: owner, admin1: admin };
    adapters = buildAdapters();
  });

  const run = (actor: IUserDocument, newOwnerId = 'admin1') =>
    transferOwnership(
      actor,
      { organizationId: 'org1', newOwnerId },
      adapters as unknown as Parameters<typeof transferOwnership>[2]
    );

  it('moves userId to the admin, swaps the roster slot, and drops the new owner from adminUserIds', async () => {
    const result = await run(owner);

    expect(adapters.db.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'org1',
        userId: 'admin1',
        adminUserIds: [],
        users: [
          { userId: 'user2', permissions: [Permission.read] },
          { userId: 'owner1', permissions: [Permission.read] },
        ],
      })
    );
    expect(adapters.db.organizations.ensureUserDetails).toHaveBeenCalledWith('org1', {
      id: 'owner1',
      email: 'owner@example.com',
      name: 'Owner',
    });
    expect(result).toMatchObject({ previousOwnerId: 'owner1', newOwnerId: 'admin1', stripeCustomerId: 'cus_1' });
  });

  it('keeps the seat count: one row leaves users[] and one joins', async () => {
    await run(owner);
    const { users } = adapters.db.organizations.update.mock.calls[0][0];
    expect(users).toHaveLength(org.users.length);
  });

  it('rewrites billingContact only when it still names the previous owner', async () => {
    const result = await run(owner);
    expect(result).toMatchObject({ billingContactChanged: true, billingContact: 'admin@example.com' });
    expect(adapters.db.organizations.update.mock.calls[0][0].billingContact).toBe('admin@example.com');
  });

  it('matches the previous owner email case-insensitively', async () => {
    org = freshOrg({ billingContact: ' Owner@Example.com ' });
    const result = await run(owner);
    expect(result.billingContactChanged).toBe(true);
    expect(adapters.db.organizations.update.mock.calls[0][0].billingContact).toBe('admin@example.com');
  });

  it('writes the new owner email trimmed and lowercased', async () => {
    usersById.admin1 = { ...admin, email: '  Admin@Example.COM ' } as IUserDocument;
    const result = await run(owner);
    expect(result.billingContact).toBe('admin@example.com');
    expect(adapters.db.organizations.update.mock.calls[0][0].billingContact).toBe('admin@example.com');
  });

  it('leaves a deliberately set billing contact alone', async () => {
    org = freshOrg({ billingContact: 'finance@example.com' });
    const result = await run(owner);
    expect(result).toMatchObject({ billingContactChanged: false, billingContact: 'finance@example.com' });
    expect(adapters.db.organizations.update.mock.calls[0][0]).not.toHaveProperty('billingContact');
  });

  it('lets a platform admin repair an org whose owner no longer exists', async () => {
    usersById.owner1 = null;
    const result = await run({ ...stranger, isAdmin: true } as IUserDocument);

    expect(result.previousOwnerId).toBeNull();
    expect(result.billingContactChanged).toBe(false);
    expect(adapters.db.organizations.update.mock.calls[0][0].adminUserIds).toEqual([]);
    expect(adapters.db.organizations.ensureUserDetails).not.toHaveBeenCalled();
    expect(adapters.db.organizations.update.mock.calls[0][0].users).toEqual([
      { userId: 'user2', permissions: [Permission.read] },
    ]);
  });

  it('does not duplicate a previous owner who already has a roster row', async () => {
    org = freshOrg({
      users: [
        { userId: 'admin1', permissions: [Permission.read] },
        { userId: 'owner1', permissions: [Permission.read] },
      ],
    });
    await run(owner);
    expect(adapters.db.organizations.update.mock.calls[0][0].users).toEqual([
      { userId: 'owner1', permissions: [Permission.read] },
    ]);
  });

  it('keeps the other admins and removes only the new owner from adminUserIds', async () => {
    org = freshOrg({ adminUserIds: ['admin1', 'admin2'] });
    await run(owner);
    expect(adapters.db.organizations.update.mock.calls[0][0].adminUserIds).toEqual(['admin2']);
  });

  it('leaves a null billing contact alone', async () => {
    org = freshOrg({ billingContact: null as unknown as string });
    const result = await run(owner);
    expect(result).toMatchObject({ billingContactChanged: false, billingContact: null });
    expect(adapters.db.organizations.update.mock.calls[0][0]).not.toHaveProperty('billingContact');
  });

  it('falls back to the username when the previous owner has no email', async () => {
    usersById.owner1 = { id: 'owner1', username: 'owner-handle', name: 'Owner' } as IUserDocument;
    const result = await run(owner);
    expect(result.billingContactChanged).toBe(false);
    expect(adapters.db.organizations.ensureUserDetails).toHaveBeenCalledWith('org1', {
      id: 'owner1',
      email: 'owner-handle',
      name: 'Owner',
    });
  });

  it('answers a caller who is neither the owner nor a platform admin as if the org did not exist', async () => {
    await expect(run(stranger)).rejects.toThrow(NotFoundError);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses an org manager who is not the owner', async () => {
    await expect(run(admin, 'admin1')).rejects.toThrow(NotFoundError);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses a target who is a plain member, not an admin', async () => {
    await expect(run(owner, 'user2')).rejects.toThrow(BadRequestError);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses an admin whose roster row confers no membership', async () => {
    org = freshOrg({ users: [{ userId: 'admin1', permissions: [] }] });
    await expect(run(owner)).rejects.toThrow(BadRequestError);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses an admin with no roster row', async () => {
    org = freshOrg({ users: [{ userId: 'user2', permissions: [Permission.read] }] });
    await expect(run(owner)).rejects.toThrow(BadRequestError);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses a transfer to the current owner', async () => {
    org = freshOrg({
      adminUserIds: ['owner1', 'admin1'],
      users: [{ userId: 'owner1', permissions: [Permission.read] }],
    });
    await expect(run(owner, 'owner1')).rejects.toThrow(/already owns/);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses a personal organization', async () => {
    org = freshOrg({ personal: true });
    await expect(run(owner)).rejects.toThrow(BadRequestError);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses a target whose account is scheduled for deletion', async () => {
    usersById.admin1 = { ...admin, deletion: { scheduledFor: new Date() } } as unknown as IUserDocument;
    await expect(run(owner)).rejects.toThrow(/scheduled for deletion/);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('refuses a target whose account is deactivated', async () => {
    usersById.admin1 = { ...admin, isBanned: true } as unknown as IUserDocument;
    await expect(run(owner)).rejects.toThrow(/deactivated/);
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('404s on a missing organization or a missing target user', async () => {
    adapters.db.organizations.findById.mockResolvedValueOnce(null);
    await expect(run(owner)).rejects.toThrow(NotFoundError);

    usersById.admin1 = null;
    await expect(run(owner)).rejects.toThrow(NotFoundError);
  });
});
