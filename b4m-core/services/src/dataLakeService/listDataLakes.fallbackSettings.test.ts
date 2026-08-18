import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { listDataLakes, listAllDataLakes } from './listDataLakes';

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'someone',
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  ...overrides,
});

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

describe('listDataLakes / listAllDataLakes - canManageSettings flag for fallback (built-in) lakes', () => {
  it('canManageSettings is true for an admin on a fallback lake (listAllDataLakes)', async () => {
    const db = { dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([]) } };
    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });
    expect(result.find(l => l.id === 'opti-knowledge')?.canManageSettings).toBe(true);
  });

  it('canManageSettings is false for a non-admin reader on a fallback lake (listDataLakes)', async () => {
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([]), find: vi.fn() } };
    const result = await listDataLakes(ctx({ userId: 'me', userTags: ['Opti'] }), { db });
    expect(result.find(l => l.id === 'opti-knowledge')?.canManageSettings).toBe(false);
  });

  it('canManageSettings === canManage for a DB lake (both true for the owner, both false for a stranger)', async () => {
    const mine = lake({ id: 'mine', slug: 'mine', createdByUserId: 'me' });
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'other', isPublic: true });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([mine, theirs]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'me' }), { db });

    expect(result.find(l => l.id === 'mine')?.canManageSettings).toBe(true);
    expect(result.find(l => l.id === 'theirs')?.canManageSettings).toBe(false);
  });
});

describe('listAllDataLakes - groundingMode overlay for fallback lakes', () => {
  it('merges the overlay groundingMode for an admin', async () => {
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([]) },
      fallbackLakeSettings: {
        findByLakeIds: vi.fn().mockResolvedValue([{ lakeId: 'opti-knowledge', groundingMode: 'inline' }]),
      },
    };
    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });
    expect(result.find(l => l.id === 'opti-knowledge')?.groundingMode).toBe('inline');
  });

  it('omits groundingMode when no overlay row exists', async () => {
    const db = {
      dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([]) },
      fallbackLakeSettings: { findByLakeIds: vi.fn().mockResolvedValue([]) },
    };
    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });
    expect(result.find(l => l.id === 'opti-knowledge')?.groundingMode).toBeUndefined();
  });

  it('lists cleanly with no overlay adapter wired (back-compat)', async () => {
    const db = { dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([]) } };
    const result = await listAllDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });
    expect(result.find(l => l.id === 'opti-knowledge')?.groundingMode).toBeUndefined();
  });
});
