import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGrantPackageRepository, IRegistrationInviteRepository, IUserDocument } from '@bike4mind/common';
import { generateReferralCodes } from './generateCodes';

const admin = { id: 'admin-1', isAdmin: true } as IUserDocument;

const setup = (pkg: Record<string, unknown> | null) => {
  const createMany = vi.fn(async (rows: unknown[]) => rows);
  const findById = vi.fn(async () => pkg);
  const db = {
    regInvites: { createMany } as unknown as IRegistrationInviteRepository,
    grantPackages: { findById } as unknown as IGrantPackageRepository,
  };
  return { db, createMany, findById };
};

describe('generateReferralCodes - grant package', () => {
  beforeEach(() => vi.clearAllMocks());

  it('copies the package amounts onto every code and links it', async () => {
    const { db, createMany } = setup({ id: 'pkg-1', credits: 300, storageMb: 200, active: true });
    await generateReferralCodes(admin, { count: 2, startingCredits: 5, grantPackageId: 'pkg-1' }, { db });
    const rows = createMany.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ grantPackageId: 'pkg-1', startingCredits: 300, startingStorage: 200 });
    }
  });

  it('keeps the typed amounts when no package is chosen', async () => {
    const { db, createMany, findById } = setup(null);
    await generateReferralCodes(admin, { count: 1, startingCredits: 40 }, { db });
    const [row] = createMany.mock.calls[0][0] as Record<string, unknown>[];
    expect(row.startingCredits).toBe(40);
    expect(row).not.toHaveProperty('grantPackageId');
    expect(findById).not.toHaveBeenCalled();
  });

  it('rejects an unknown package', async () => {
    const { db, createMany } = setup(null);
    await expect(generateReferralCodes(admin, { grantPackageId: 'missing' }, { db })).rejects.toThrow(
      'Grant package not found'
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects an inactive package', async () => {
    const { db, createMany } = setup({ id: 'pkg-1', credits: 300, active: false });
    await expect(generateReferralCodes(admin, { grantPackageId: 'pkg-1' }, { db })).rejects.toThrow(
      'Grant package is inactive'
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects an empty package id', async () => {
    const { db, createMany } = setup(null);
    await expect(generateReferralCodes(admin, { grantPackageId: '' }, { db })).rejects.toThrow();
    expect(createMany).not.toHaveBeenCalled();
  });
});
