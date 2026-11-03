import { adminSettingsRepository, User } from '@bike4mind/database';
import {
  RESERVED_USERNAME_PREFIX,
  internalStaffEmailRegex,
  isInternalIdentity,
  isSyntheticIdentity,
  parseInternalStaffDomains,
  parseSyntheticDomainList,
} from '@bike4mind/common';
import type { Types } from 'mongoose';
import { type MigrationFile } from './index';

const LOG = '[backfill-user-lane-flags]';

/**
 * Signup has classified accounts as synthetic since the release of 2026-10-10 (evening UTC), so an
 * account created before this instant was never classified. Used only to split the report: the
 * backfill itself applies the signup rule to every account, whenever it was made (see below).
 */
export const SYNTHETIC_FLAG_SHIPPED_AT = new Date('2026-10-11T00:00:00Z');

/** Accounts per update, so one `$in` stays small. */
const BATCH = 1000;

type Row = {
  _id: Types.ObjectId;
  username?: string | null;
  email?: string | null;
  isAdmin?: boolean | null;
  isSynthetic?: boolean | null;
  isInternal?: boolean | null;
  createdAt?: Date | null;
};

/** What the backfill marks, by the rule that marks it. Counts only: no address is reported. */
export interface UserLaneBackfillPlan {
  internal: { admins: number; staffDomain: number; ids: Types.ObjectId[] };
  synthetic: { persona: number; testDomain: number; createdBeforeFlag: number; ids: Types.ObjectId[] };
  /** How many staff domains were configured: 0 means only admins could be marked internal. */
  staffDomains: number;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A prefilter for emails on a test domain or under one; isSyntheticIdentity has the last word. */
function testDomainEmailRegex(domains: readonly string[]): RegExp | null {
  if (domains.length === 0) return null;
  return new RegExp(`@(?:[^@]*\\.)?(?:${domains.map(escapeRegExp).join('|')})$`, 'i');
}

/**
 * The accounts the backfill would mark, without writing anything.
 *
 * - `isInternal`: every admin, and every account whose email is on a NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS
 *   domain, as signup now marks a new one (isInternalIdentity).
 * - `isSynthetic`: every `persona-*` username and every email on a domain in the
 *   `syntheticUserEmailDomains` setting, as signup marks a new one (isSyntheticIdentity). Not only
 *   those made before signup classified them: the same rule also finds accounts signup missed after
 *   it, such as ones on a wildcard or trailing-dot setting entry, which matched nothing until the
 *   release of 2026-10-24, and ones whose classification write failed. The report says how many
 *   predate the flag.
 *
 * The database query is a prefilter; each candidate is then decided by the same function signup
 * uses, so the two rules cannot drift apart. An account already flagged is not a candidate, which is
 * what makes a re-run plan nothing.
 */
export async function planUserLaneBackfill(): Promise<UserLaneBackfillPlan> {
  const staffDomains = parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS);
  const testDomains = parseSyntheticDomainList(
    await adminSettingsRepository.getSettingsValue('syntheticUserEmailDomains')
  );
  const staffRegex = internalStaffEmailRegex(staffDomains);
  const testRegex = testDomainEmailRegex(testDomains);
  const personaRegex = new RegExp(`^${escapeRegExp(RESERVED_USERNAME_PREFIX)}`, 'i');

  const plan: UserLaneBackfillPlan = {
    internal: { admins: 0, staffDomain: 0, ids: [] },
    synthetic: { persona: 0, testDomain: 0, createdBeforeFlag: 0, ids: [] },
    staffDomains: staffDomains.length,
  };

  const candidates = User.collection.find<Row>(
    {
      $or: [
        { isInternal: { $ne: true }, $or: [{ isAdmin: true }, ...(staffRegex ? [{ email: staffRegex }] : [])] },
        {
          isSynthetic: { $ne: true },
          $or: [{ username: personaRegex }, ...(testRegex ? [{ email: testRegex }] : [])],
        },
      ],
    },
    { projection: { username: 1, email: 1, isAdmin: 1, isSynthetic: 1, isInternal: 1, createdAt: 1 } }
  );

  for await (const row of candidates) {
    if (row.isInternal !== true && isInternalIdentity(row, staffDomains)) {
      plan.internal.ids.push(row._id);
      if (row.isAdmin === true) plan.internal.admins++;
      else plan.internal.staffDomain++;
    }
    if (row.isSynthetic !== true && isSyntheticIdentity(row, testDomains)) {
      plan.synthetic.ids.push(row._id);
      if (isSyntheticIdentity({ username: row.username }, [])) plan.synthetic.persona++;
      else plan.synthetic.testDomain++;
      if (row.createdAt && row.createdAt < SYNTHETIC_FLAG_SHIPPED_AT) plan.synthetic.createdBeforeFlag++;
    }
  }
  return plan;
}

/** Sets `field` to true on `ids`, in batches; an account flagged meanwhile is left as it is. */
async function markAll(ids: Types.ObjectId[], field: 'isInternal' | 'isSynthetic'): Promise<number> {
  let modified = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const result = await User.collection.updateMany(
      { _id: { $in: ids.slice(i, i + BATCH) }, [field]: { $ne: true } },
      { $set: { [field]: true } }
    );
    modified += result.modifiedCount;
  }
  return modified;
}

/**
 * Flag existing accounts the way signup flags new ones: `isInternal` on admins and staff-domain
 * accounts, `isSynthetic` on persona and test-domain accounts (see planUserLaneBackfill). Each
 * account's later analytics events then carry the mark (server-utils analytics/lane.ts).
 *
 * Reports what it marks before it writes, by rule, and how many it changed after. Idempotent: it
 * only ever sets a flag to true on an account that does not have it, so a re-run marks nothing.
 * Run again after adding a staff domain or a test domain to pick up the accounts already on it.
 */
// Id below the fail-closed OAuth backfill (20260922000001), so that one cannot block it.
const migration: MigrationFile = {
  id: 20260921238100,
  name: 'backfill-user-lane-flags',

  up: async () => {
    const plan = await planUserLaneBackfill();
    if (plan.staffDomains === 0) {
      console.warn(`${LOG} NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty: only admins are marked internal`);
    }
    console.log(
      `${LOG} to mark isInternal: ${plan.internal.ids.length} (${plan.internal.admins} admins, ` +
        `${plan.internal.staffDomain} staff-domain); isSynthetic: ${plan.synthetic.ids.length} ` +
        `(${plan.synthetic.persona} persona usernames, ${plan.synthetic.testDomain} test-domain emails; ` +
        `${plan.synthetic.createdBeforeFlag} created before ${SYNTHETIC_FLAG_SHIPPED_AT.toISOString().slice(0, 10)})`
    );

    const internal = await markAll(plan.internal.ids, 'isInternal');
    const synthetic = await markAll(plan.synthetic.ids, 'isSynthetic');
    console.log(`${LOG} marked ${internal} account(s) internal and ${synthetic} synthetic`);
  },

  // No-op: a flag set here is indistinguishable from one signup or an admin set, and either may
  // have happened since.
  down: async () => {},
};

export default migration;
