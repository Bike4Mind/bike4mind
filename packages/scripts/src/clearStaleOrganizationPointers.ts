import { organizationRepository, User } from '@bike4mind/database';
import mongoose from 'mongoose';

export type StalePointerReason = 'org-missing' | 'not-member';

export interface ClearStaleOrganizationPointersOptions {
  /** Default false: report the pointers that would be nulled and write nothing. */
  apply?: boolean;
  log?: (message: string) => void;
}

export interface StaleOrganizationPointers {
  organizationId: string;
  reason: StalePointerReason;
  userIds: string[];
}

export interface ClearStaleOrganizationPointersResult {
  orgs: StaleOrganizationPointers[];
  byReason: Record<StalePointerReason, number>;
  /** Pointers actually nulled (0 on a dry run). */
  cleared: number;
}

// The raw collection skips Mongoose casting, so a pointer stored as a string is matched alongside
// the ObjectId form instead of being silently missed.
const pointerValues = (organizationId: string): unknown[] =>
  mongoose.isValidObjectId(organizationId)
    ? [new mongoose.Types.ObjectId(organizationId), organizationId]
    : [organizationId];

/**
 * Null `organizationId` on the given users, but only where it still points at this org, so a user
 * who switched or re-joined orgs between detection and write is left alone. Returns the count nulled.
 */
export async function clearPointers(organizationId: string, userIds: string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const result = await User.collection.updateMany(
    {
      _id: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) },
      organizationId: { $in: pointerValues(organizationId) },
    },
    { $set: { organizationId: null } }
  );
  return result.modifiedCount;
}

/**
 * Find every user whose `organizationId` targets an org that is missing/soft-deleted or does not
 * count them as a member, and (with `apply`) null the pointer. Membership is read through
 * organizationRepository.findMemberUserIds, so this never re-implements orgMembershipFilter.
 * Idempotent: a second run finds nothing.
 */
export async function clearStaleOrganizationPointers({
  apply = false,
  log = console.log,
}: ClearStaleOrganizationPointersOptions = {}): Promise<ClearStaleOrganizationPointersResult> {
  const rawOrgIds = await User.collection.distinct('organizationId', { organizationId: { $ne: null } });
  const orgIds = [...new Set(rawOrgIds.map(id => String(id)))];

  const orgs: StaleOrganizationPointers[] = [];
  const byReason: Record<StalePointerReason, number> = { 'org-missing': 0, 'not-member': 0 };
  let cleared = 0;

  for (const organizationId of orgIds) {
    // All-empty means the org is missing or soft-deleted: a live org always lists its owner.
    const { userIds, stampOnly } = await organizationRepository.findMemberUserIds(organizationId);
    const reason: StalePointerReason = userIds.length === 0 ? 'org-missing' : 'not-member';
    const stampOnlySet = new Set(stampOnly);
    const members = new Set(userIds.filter(id => !stampOnlySet.has(id)));

    // Re-read the pointers raw rather than trusting stampOnly, whose cast query misses string-stored ones.
    const pointing = await User.collection
      .find({ organizationId: { $in: pointerValues(organizationId) } }, { projection: { _id: 1 } })
      .toArray();
    const stale = pointing.map(u => String(u._id)).filter(id => !members.has(id));
    if (stale.length === 0) continue;

    orgs.push({ organizationId, reason, userIds: stale });
    byReason[reason] += stale.length;
    log(`org ${organizationId}: ${reason}, ${stale.length} stale pointer(s)`);
    if (apply) cleared += await clearPointers(organizationId, stale);
  }

  log(
    `Stale pointers: ${byReason['org-missing']} org-missing, ${byReason['not-member']} not-member` +
      (apply ? `; nulled ${cleared}.` : '.')
  );
  return { orgs, byReason, cleared };
}
