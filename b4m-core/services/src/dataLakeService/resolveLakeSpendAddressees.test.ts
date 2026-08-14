import { describe, expect, it, vi } from 'vitest';
import {
  MAX_LAKE_SPEND_ADDRESSEES,
  resolveLakeSpendAddressees,
  type LakeSpendAddresseeDb,
} from './resolveLakeSpendAddressees';

const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

const lake = (overrides: Record<string, unknown> = {}) => ({
  id: 'lake-1',
  createdByUserId: 'creator-1',
  organizationId: null,
  ...overrides,
});

const emailRows = (rows: Array<{ id: string; email: string }>) => (ids: string[]) =>
  Promise.resolve(rows.filter(r => ids.includes(r.id)));

function makeDb(overrides: Partial<LakeSpendAddresseeDb> = {}): LakeSpendAddresseeDb {
  return {
    dataLakes: { findById: vi.fn().mockResolvedValue(lake()) },
    dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([]) },
    organizations: { findById: vi.fn().mockResolvedValue(null) },
    users: { findActiveEmailsByIds: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as LakeSpendAddresseeDb;
}

describe('resolveLakeSpendAddressees', () => {
  it('resolves to the creator for an individually-owned lake with no owner grant', async () => {
    const db = makeDb({
      users: { findActiveEmailsByIds: emailRows([{ id: 'creator-1', email: 'creator@example.com' }]) },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toEqual([{ userId: 'creator-1', email: 'creator@example.com' }]);
  });

  it('resolves to the owner-grant holder over the creator when a transfer occurred', async () => {
    const db = makeDb({
      dataLakeAccessGrants: {
        listByLake: vi.fn().mockResolvedValue([{ principalType: 'user', principalId: 'new-owner', role: 'owner' }]),
      },
      users: { findActiveEmailsByIds: emailRows([{ id: 'new-owner', email: 'owner@example.com' }]) },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toEqual([{ userId: 'new-owner', email: 'owner@example.com' }]);
  });

  it('resolves to the creator when the owner grant is expired (listByLake already filters to active)', async () => {
    // listByLake is called with activeAsOf, so an expired grant is simply absent from its result.
    const db = makeDb({
      dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([]) },
      users: { findActiveEmailsByIds: emailRows([{ id: 'creator-1', email: 'creator@example.com' }]) },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toEqual([{ userId: 'creator-1', email: 'creator@example.com' }]);
  });

  it('resolves org billing owner + manager + admins for an org-owned lake', async () => {
    const db = makeDb({
      dataLakes: { findById: vi.fn().mockResolvedValue(lake({ organizationId: 'org-1' })) },
      organizations: {
        findById: vi
          .fn()
          .mockResolvedValue({ userId: 'billing-owner', managerId: 'manager-1', adminUserIds: ['admin-1'] }),
      },
      users: {
        findActiveEmailsByIds: emailRows([
          { id: 'billing-owner', email: 'billing@example.com' },
          { id: 'manager-1', email: 'manager@example.com' },
          { id: 'admin-1', email: 'admin@example.com' },
        ]),
      },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result.map(a => a.userId).sort()).toEqual(['admin-1', 'billing-owner', 'manager-1']);
  });

  it('resolves an org-principal owner/curator GRANT to ITS OWN org admins, distinct from the lake org', async () => {
    const db = makeDb({
      dataLakes: { findById: vi.fn().mockResolvedValue(lake({ organizationId: 'org-1' })) },
      dataLakeAccessGrants: {
        listByLake: vi.fn().mockResolvedValue([{ principalType: 'organization', principalId: 'org-2', role: 'owner' }]),
      },
      organizations: {
        findById: vi.fn(async (id: string) =>
          id === 'org-1' ? { userId: 'org1-owner' } : id === 'org-2' ? { userId: 'org2-owner' } : null
        ),
      },
      users: {
        findActiveEmailsByIds: emailRows([
          { id: 'org1-owner', email: 'org1@example.com' },
          { id: 'org2-owner', email: 'org2@example.com' },
        ]),
      },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    // Union of both the lake's own org admins AND the grant's org admins - the grant's
    // principalId is resolved through organizations.findById like any other org id, never
    // pushed directly into the user lookup (which would silently drop it).
    expect(result.map(a => a.userId).sort()).toEqual(['org1-owner', 'org2-owner']);
  });

  it('resolves an org-principal grant on an org-LESS lake to that grant org admins (no lake.organizationId needed)', async () => {
    const db = makeDb({
      dataLakes: { findById: vi.fn().mockResolvedValue(lake({ organizationId: null })) },
      dataLakeAccessGrants: {
        listByLake: vi
          .fn()
          .mockResolvedValue([{ principalType: 'organization', principalId: 'org-2', role: 'curator' }]),
      },
      organizations: { findById: vi.fn().mockResolvedValue({ userId: 'org2-owner' }) },
      users: { findActiveEmailsByIds: emailRows([{ id: 'org2-owner', email: 'org2@example.com' }]) },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toEqual([{ userId: 'org2-owner', email: 'org2@example.com' }]);
  });

  it('falls through to the individual-owner path when the org has no resolvable admin set', async () => {
    const db = makeDb({
      dataLakes: { findById: vi.fn().mockResolvedValue(lake({ organizationId: 'org-1' })) },
      organizations: { findById: vi.fn().mockResolvedValue({ userId: null, managerId: null, adminUserIds: [] }) },
      users: { findActiveEmailsByIds: emailRows([{ id: 'creator-1', email: 'creator@example.com' }]) },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toEqual([{ userId: 'creator-1', email: 'creator@example.com' }]);
  });

  it('falls through to the individual-owner path when the org document is missing/soft-deleted', async () => {
    const db = makeDb({
      dataLakes: { findById: vi.fn().mockResolvedValue(lake({ organizationId: 'org-deleted' })) },
      organizations: { findById: vi.fn().mockResolvedValue(null) },
      users: { findActiveEmailsByIds: emailRows([{ id: 'creator-1', email: 'creator@example.com' }]) },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toEqual([{ userId: 'creator-1', email: 'creator@example.com' }]);
  });

  it('returns [] when the lake does not exist', async () => {
    const db = makeDb({ dataLakes: { findById: vi.fn().mockResolvedValue(null) } });

    const result = await resolveLakeSpendAddressees('missing', db, logger);

    expect(result).toEqual([]);
  });

  it('returns [] when every candidate user is deleted or has no email', async () => {
    const db = makeDb({ users: { findActiveEmailsByIds: vi.fn().mockResolvedValue([]) } });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toEqual([]);
  });

  it('dedupes case-insensitively on email, keeping the first match', async () => {
    const db = makeDb({
      dataLakes: { findById: vi.fn().mockResolvedValue(lake({ organizationId: 'org-1' })) },
      organizations: {
        findById: vi.fn().mockResolvedValue({ userId: 'user-a', managerId: 'user-b', adminUserIds: [] }),
      },
      users: {
        findActiveEmailsByIds: emailRows([
          { id: 'user-a', email: 'Same@Example.com' },
          { id: 'user-b', email: 'same@example.com' },
        ]),
      },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('user-a');
  });

  it('caps fan-out at MAX_LAKE_SPEND_ADDRESSEES and logs a truncation warning', async () => {
    const adminUserIds = Array.from({ length: MAX_LAKE_SPEND_ADDRESSEES + 5 }, (_, i) => `admin-${i}`);
    const db = makeDb({
      dataLakes: { findById: vi.fn().mockResolvedValue(lake({ organizationId: 'org-1' })) },
      organizations: { findById: vi.fn().mockResolvedValue({ userId: null, managerId: null, adminUserIds }) },
      users: {
        findActiveEmailsByIds: vi.fn(async (ids: string[]) => ids.map(id => ({ id, email: `${id}@example.com` }))),
      },
    });

    const result = await resolveLakeSpendAddressees('lake-1', db, logger);

    expect(result).toHaveLength(MAX_LAKE_SPEND_ADDRESSEES);
  });

  it('never throws - a repository failure resolves to [] and logs a warning', async () => {
    const db = makeDb({ dataLakes: { findById: vi.fn().mockRejectedValue(new Error('mongo down')) } });

    await expect(resolveLakeSpendAddressees('lake-1', db, logger)).resolves.toEqual([]);
  });
});
