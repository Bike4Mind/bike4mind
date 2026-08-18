import { describe, it, expect, vi } from 'vitest';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { assertLakeAccess, assertLakeWritable } from './assertLakeAccess';
import { assertFallbackLakeSettingsWriteAccess } from './authorizeLakeWrite';
import { updateFallbackLakeSettings } from './updateFallbackLakeSettings';

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

// The DB knows nothing: both lookups miss, as they do for the seeded opti-knowledge lake.
const fallbackDb = () => ({
  dataLakes: {
    findById: vi.fn().mockRejectedValue(new Error('bad id')),
    findBySlug: vi.fn().mockResolvedValue(null),
  },
});

describe('resolveFallbackLake (via assertLakeAccess) - merges the groundingMode overlay', () => {
  it('resolves the coded default when no overlay adapter is wired (back-compat)', async () => {
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ userTags: ['opti'] }), { db: fallbackDb() });
    expect(resolved.groundingMode).toBeUndefined();
  });

  it('resolves the coded default when the overlay adapter finds no row', async () => {
    const db = { ...fallbackDb(), fallbackLakeSettings: { findByLakeId: vi.fn().mockResolvedValue(null) } };
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ userTags: ['opti'] }), { db });
    expect(resolved.groundingMode).toBeUndefined();
  });

  it('merges the overlay groundingMode when a row exists', async () => {
    const findByLakeId = vi.fn().mockResolvedValue({ lakeId: 'opti-knowledge', groundingMode: 'inline' });
    const db = { ...fallbackDb(), fallbackLakeSettings: { findByLakeId } };
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ userTags: ['opti'] }), { db });
    expect(resolved.groundingMode).toBe('inline');
    expect(findByLakeId).toHaveBeenCalledWith('opti-knowledge');
  });

  it('degrades to the coded default when the overlay read throws', async () => {
    const db = {
      ...fallbackDb(),
      fallbackLakeSettings: { findByLakeId: vi.fn().mockRejectedValue(new Error('down')) },
    };
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ userTags: ['opti'] }), { db });
    expect(resolved.groundingMode).toBeUndefined();
  });

  it('never merges the overlay onto a real DB lake shadowing the same slug', async () => {
    const dbLake = lake({ id: 'real-id', slug: 'opti-knowledge', createdByUserId: 'owner' });
    const findByLakeId = vi.fn();
    const db = {
      dataLakes: {
        findById: vi.fn().mockRejectedValue(new Error('bad id')),
        findBySlug: vi.fn().mockResolvedValue(dbLake),
      },
      fallbackLakeSettings: { findByLakeId },
    };
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ userId: 'owner' }), { db });
    expect(resolved).toBe(dbLake);
    expect(findByLakeId).not.toHaveBeenCalled();
  });
});

describe('assertFallbackLakeSettingsWriteAccess', () => {
  it("a platform admin CAN write a fallback lake's settings", async () => {
    const resolved = await assertFallbackLakeSettingsWriteAccess('opti-knowledge', ctx({ isAdmin: true }), {
      db: fallbackDb(),
    });
    expect(resolved.id).toBe('opti-knowledge');
  });

  it("a non-admin with lake access (tag) still CANNOT write a fallback lake's settings", async () => {
    await expect(
      assertFallbackLakeSettingsWriteAccess('opti-knowledge', ctx({ userTags: ['opti'] }), { db: fallbackDb() })
    ).rejects.toThrow(/permission to change/i);
  });

  it('refuses a DB (persisted) lake outright - it has its own settings editor', async () => {
    const l = lake({ createdByUserId: 'owner' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(assertFallbackLakeSettingsWriteAccess('lake1', ctx({ isAdmin: true }), { db })).rejects.toThrow(
      /its own settings editor/i
    );
  });

  it('assertLakeWritable itself still refuses a fallback lake (untouched by this gate)', () => {
    expect(() => assertLakeWritable({ id: 'opti-knowledge' })).toThrow(/read-only/i);
  });
});

describe('updateFallbackLakeSettings', () => {
  // findByLakeId is stubbed too: assertLakeAccess (called via assertFallbackLakeSettingsWriteAccess)
  // reads it on every resolution, independent of whether this call writes anything.
  it('persists groundingMode via the overlay repo and returns it merged onto the lake', async () => {
    const setGroundingMode = vi.fn().mockResolvedValue({ lakeId: 'opti-knowledge', groundingMode: 'inline' });
    const findByLakeId = vi.fn().mockResolvedValue(null);
    const db = { ...fallbackDb(), fallbackLakeSettings: { setGroundingMode, findByLakeId } };

    const result = await updateFallbackLakeSettings(
      'opti-knowledge',
      ctx({ isAdmin: true }),
      { groundingMode: 'inline' },
      { db }
    );

    expect(setGroundingMode).toHaveBeenCalledWith('opti-knowledge', 'inline');
    expect(result.groundingMode).toBe('inline');
  });

  it('is a no-op write when groundingMode is omitted (unchanged wins)', async () => {
    const setGroundingMode = vi.fn();
    const findByLakeId = vi.fn().mockResolvedValue(null);
    const db = { ...fallbackDb(), fallbackLakeSettings: { setGroundingMode, findByLakeId } };

    const result = await updateFallbackLakeSettings('opti-knowledge', ctx({ isAdmin: true }), {}, { db });

    expect(setGroundingMode).not.toHaveBeenCalled();
    expect(result.groundingMode).toBeUndefined();
  });

  it('refuses a non-admin before ever touching the overlay repo', async () => {
    const setGroundingMode = vi.fn();
    const findByLakeId = vi.fn().mockResolvedValue(null);
    const db = { ...fallbackDb(), fallbackLakeSettings: { setGroundingMode, findByLakeId } };

    await expect(
      updateFallbackLakeSettings('opti-knowledge', ctx({ userTags: ['opti'] }), { groundingMode: 'inline' }, { db })
    ).rejects.toThrow(/permission to change/i);
    expect(setGroundingMode).not.toHaveBeenCalled();
  });
});
