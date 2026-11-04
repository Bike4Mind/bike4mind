import { describe, expect, it } from 'vitest';
import {
  createGrantPackageSchema,
  grantPackageCapsConflict,
  grantPackageExposure,
  requiresGrantReason,
  updateGrantPackageSchema,
  updateRequiresGrantReason,
} from './grantPackage';

const policy = { singleGrantCredits: 50_000, dailyTotalCredits: 200_000 };
const base = { name: 'Launch', credits: 100, totalCap: 1, dailyCap: null };

describe('requiresGrantReason', () => {
  it('does not require a reason for a small capped package', () => {
    expect(requiresGrantReason({ credits: 100, totalCap: 1 }, policy)).toBe(false);
  });

  it('requires a reason when one signup exceeds the single-grant threshold', () => {
    expect(requiresGrantReason({ credits: 50_001, totalCap: 1 }, policy)).toBe(true);
    expect(requiresGrantReason({ credits: 50_000, totalCap: 1 }, policy)).toBe(false);
  });

  it('requires a reason when the capped run can exceed the daily threshold', () => {
    expect(requiresGrantReason({ credits: 1_000, totalCap: 201 }, policy)).toBe(true);
    expect(requiresGrantReason({ credits: 1_000, totalCap: 200 }, policy)).toBe(false);
  });

  it('treats an uncapped package with credits as unbounded, and a zero-credit one as harmless', () => {
    expect(requiresGrantReason({ credits: 1, totalCap: null }, policy)).toBe(true);
    expect(requiresGrantReason({ credits: 0, totalCap: null }, policy)).toBe(false);
    expect(grantPackageExposure({ credits: 0, totalCap: null })).toBe(0);
  });
});

describe('updateRequiresGrantReason', () => {
  const large = { credits: 1_000, totalCap: 500, active: true };

  it('requires a reason when an edit removes the cap of a live package', () => {
    expect(
      updateRequiresGrantReason(
        { credits: 100, totalCap: 1, active: true },
        { credits: 100, totalCap: null, active: true },
        policy
      )
    ).toBe(true);
  });

  it('does not require a reason to shrink or deactivate a large package', () => {
    expect(updateRequiresGrantReason(large, { ...large, totalCap: 400 }, policy)).toBe(false);
    expect(updateRequiresGrantReason(large, { ...large, active: false }, policy)).toBe(false);
  });

  it('requires a reason to reactivate a large package', () => {
    expect(updateRequiresGrantReason({ ...large, active: false }, large, policy)).toBe(true);
  });
});

describe('admin package schemas', () => {
  it.each([0, -1, 1.5, '3', ''])('rejects cap %j', cap => {
    expect(createGrantPackageSchema.safeParse({ ...base, totalCap: cap }).success).toBe(false);
  });

  it('rejects unknown keys, including a reason, so the route must split it off first', () => {
    expect(createGrantPackageSchema.safeParse({ ...base, reason: 'Pilot access' }).success).toBe(false);
    expect(updateGrantPackageSchema.safeParse({ redeemedTotal: 0 }).success).toBe(false);
  });

  it('bounds the name and tags like invite generation', () => {
    expect(createGrantPackageSchema.safeParse({ ...base, name: 'n'.repeat(101) }).success).toBe(false);
    expect(createGrantPackageSchema.safeParse({ ...base, tags: ['t'.repeat(101)] }).success).toBe(false);
    expect(
      createGrantPackageSchema.safeParse({ ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success
    ).toBe(false);
    expect(
      createGrantPackageSchema.safeParse({ ...base, tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }).success
    ).toBe(true);
  });

  it('flags a daily cap above the total cap only when both are set', () => {
    expect(grantPackageCapsConflict({ totalCap: 5, dailyCap: 6 })).toBe(true);
    expect(grantPackageCapsConflict({ totalCap: 5, dailyCap: 5 })).toBe(false);
    expect(grantPackageCapsConflict({ totalCap: null, dailyCap: 6 })).toBe(false);
    expect(grantPackageCapsConflict({ totalCap: 5, dailyCap: null })).toBe(false);
  });

  it('accepts a partial edit', () => {
    expect(updateGrantPackageSchema.parse({ totalCap: null })).toEqual({ totalCap: null });
  });
});
