import { z } from 'zod';
import type { GrantPackageRefusalReason } from '../types/entities/GrantPackageTypes';

const capSchema = z.number().int().min(1).nullable();

export const grantPackageInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  credits: z.number().int().min(0),
  storageMb: z.number().int().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  totalCap: capSchema,
  dailyCap: capSchema,
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).nullable().optional(),
});

/**
 * A daily cap above the total cap can never bind. Not a schema refine: refinements make zod v4 throw
 * on the `.omit()`/`.partial()` derivations below, so the admin routes call this (PATCH on the merged values).
 */
export const grantPackageCapsConflict = (caps: { totalCap?: number | null; dailyCap?: number | null }): boolean =>
  caps.totalCap != null && caps.dailyCap != null && caps.dailyCap > caps.totalCap;

export const GRANT_PACKAGE_CAPS_CONFLICT_MESSAGE = 'dailyCap: must not exceed totalCap';

export type GrantPackageInput = z.infer<typeof grantPackageInputSchema>;

/** Admin create body; `reason` is validated separately, since only a large grant requires one. */
export const createGrantPackageSchema = grantPackageInputSchema.omit({ reason: true }).strict();
export type CreateGrantPackageInput = z.infer<typeof createGrantPackageSchema>;

/** Admin edit body. Packages are deactivated, never deleted, so redemption history keeps its target. */
export const updateGrantPackageSchema = createGrantPackageSchema.partial().strict();
export type UpdateGrantPackageInput = z.infer<typeof updateGrantPackageSchema>;

/** Same thresholds as the admin audit's large-grant escalation (AdminAuditCriticalGrantCredits / DailyGrantCredits). */
export type GrantPackageReasonPolicy = { singleGrantCredits: number; dailyTotalCredits: number };

type GrantPackageExposureShape = { credits: number; totalCap: number | null };

/** Most credits the package can ever hand out; an uncapped package with credits is unbounded. */
export const grantPackageExposure = ({ credits, totalCap }: GrantPackageExposureShape): number =>
  credits === 0 ? 0 : credits * (totalCap ?? Infinity);

/**
 * A package needs an admin reason when one redemption exceeds the single-grant threshold or its
 * whole run can exceed the daily threshold. The server enforces this; the admin form mirrors it.
 */
export const requiresGrantReason = (pkg: GrantPackageExposureShape, policy: GrantPackageReasonPolicy): boolean =>
  pkg.credits > policy.singleGrantCredits || grantPackageExposure(pkg) > policy.dailyTotalCredits;

/**
 * An edit needs a reason when it leaves a large package live and widens what it can hand out
 * (more credits per signup, a raised or removed cap, or reactivation). Shrinking one does not.
 */
export const updateRequiresGrantReason = (
  before: GrantPackageExposureShape & { active: boolean },
  after: GrantPackageExposureShape & { active: boolean },
  policy: GrantPackageReasonPolicy
): boolean =>
  after.active &&
  requiresGrantReason(after, policy) &&
  (!before.active || after.credits > before.credits || grantPackageExposure(after) > grantPackageExposure(before));

/** UTC calendar day a daily cap counts against. */
export const grantPackageDay = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export const GRANT_PACKAGE_INBOX_CLAIMED_MESSAGE = 'This inbox has already received a signup grant';

export function grantPackageRefusalMessage(reason: GrantPackageRefusalReason): string {
  switch (reason) {
    case 'total_cap':
      return 'This invite code has reached its signup limit';
    case 'daily_cap':
      return 'This invite code has reached its signup limit for today, please try again tomorrow';
    case 'inactive':
      return 'This invite code is no longer active';
  }
}
