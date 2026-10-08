import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IUserDocument } from '@bike4mind/common';
import { organizationRepository, User } from '@bike4mind/database';
import mongoose from 'mongoose';

export type StalePointerReason = 'org-missing' | 'not-member';

export interface ClearStaleOrganizationPointersOptions {
  /** Default false: report the pointers that would be nulled and write nothing. */
  apply?: boolean;
  /**
   * JSON file to record every stale pointer (org, reason, user ids) in, written before any write.
   * Created with mode 0600; an existing file is refused rather than overwritten.
   */
  reportPath?: string;
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
 * CLI args for repair-stale-organization-pointers.ts. The report holds production user ids, so it
 * defaults to the OS temp dir (never the checkout); an explicit --report must carry a path value.
 */
export function parseRepairArgs(argv: string[]): { apply: boolean; reportPath: string } {
  const reportArg = argv.find(arg => arg === '--report' || arg.startsWith('--report='));
  let reportPath: string;
  if (reportArg === undefined) {
    reportPath = join(tmpdir(), `stale-organization-pointers-${Date.now()}.json`);
  } else if (reportArg.startsWith('--report=')) {
    reportPath = reportArg.slice('--report='.length);
  } else {
    reportPath = argv[argv.indexOf('--report') + 1];
  }
  if (!reportPath || reportPath.startsWith('--')) throw new Error('--report needs a file path');
  return { apply: argv.includes('--apply'), reportPath };
}

/**
 * Grade one org's pointers: the ids pointing at it that it no longer admits. Keep-predicate mirrored
 * from apps/client/server/utils/resolveActiveOrg.ts; change both together.
 */
async function gradeOrg(organizationId: string): Promise<{ reason: StalePointerReason; stale: string[] }> {
  // Pointers before membership, so a user who joins mid-scan is read as a member, not graded stale.
  // Read raw rather than trusting stampOnly, whose cast query misses string-stored pointers.
  const pointing = await User.collection
    .find({ organizationId: { $in: pointerValues(organizationId) } }, { projection: { _id: 1, isAdmin: 1, groups: 1 } })
    .toArray();

  // All-empty means the org is missing or soft-deleted: a live org always lists its owner.
  const { userIds, stampOnly } = await organizationRepository.findMemberUserIds(organizationId);
  const reason: StalePointerReason = userIds.length === 0 ? 'org-missing' : 'not-member';
  const stampOnlySet = new Set(stampOnly);
  const members = new Set(userIds.filter(id => !stampOnlySet.has(id)));

  const stale: string[] = [];
  for (const user of pointing) {
    const id = String(user._id);
    if (members.has(id)) continue;
    // findAccessibleById reads only id and groups, but IOrganizationRepository types it as a full
    // IUserDocument (the database impl already takes a Pick).
    const aclUser = { id, groups: user.groups ?? [] } as IUserDocument;
    if (
      reason === 'not-member' &&
      (user.isAdmin || (await organizationRepository.shareable.findAccessibleById(aclUser, organizationId)))
    ) {
      continue;
    }
    stale.push(id);
  }
  return { reason, stale };
}

/**
 * Find every user whose `organizationId` targets an org that is missing/soft-deleted or does not
 * count them as a member, and (with `apply`) null the pointer. Membership is read through
 * organizationRepository.findMemberUserIds, so this never re-implements orgMembershipFilter; a
 * pointer the billing gate still honours (resolveActiveOrg: any platform admin, or a non-admin the
 * shareable ACL admits, groups[] arm included) is kept even when that set excludes the user.
 * The report is written before any write, and each org is re-graded right before its write, which
 * narrows (but does not close) the race with a concurrent membership change: only ids that are in
 * the report AND still stale are nulled, so every nulled pointer is in the report, while the report
 * can list an id a later write no longer nulls.
 * Idempotent: a second run finds nothing, except a legacy `permissions: []` partner-rule row, whose
 * pointer applyPartnerRuleMembership re-sets on the user's next signup/verify.
 */
export async function clearStaleOrganizationPointers({
  apply = false,
  reportPath,
  log = console.log,
}: ClearStaleOrganizationPointersOptions = {}): Promise<ClearStaleOrganizationPointersResult> {
  const rawOrgIds = await User.collection.distinct('organizationId', { organizationId: { $ne: null } });
  const orgIds = [...new Set(rawOrgIds.map(id => String(id)))];

  const orgs: StaleOrganizationPointers[] = [];
  const byReason: Record<StalePointerReason, number> = { 'org-missing': 0, 'not-member': 0 };

  for (const organizationId of orgIds) {
    const { reason, stale } = await gradeOrg(organizationId);
    if (stale.length === 0) continue;

    orgs.push({ organizationId, reason, userIds: stale });
    byReason[reason] += stale.length;
    log(`org ${organizationId}: ${reason}, ${stale.length} stale pointer(s)`);
  }

  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ apply, orgs }, null, 2), { mode: 0o600, flag: 'wx' });
    log(`Wrote the stale pointer list to ${reportPath}.`);
  }

  let cleared = 0;
  if (apply) {
    for (const { organizationId, userIds } of orgs) {
      const reported = new Set(userIds);
      const { stale } = await gradeOrg(organizationId);
      const toClear = stale.filter(id => reported.has(id));
      // The report lists the plan from the first grading pass; a membership change since then can
      // shrink the outcome, so log it instead of letting the report silently overstate the write.
      if (toClear.length < reported.size) {
        log(`org ${organizationId}: nulled ${toClear.length} of ${reported.size} listed pointer(s)`);
      }
      cleared += await clearPointers(organizationId, toClear);
    }
  }

  log(
    `Stale pointers: ${byReason['org-missing']} org-missing, ${byReason['not-member']} not-member` +
      (apply ? `; nulled ${cleared}.` : '.')
  );
  return { orgs, byReason, cleared };
}
