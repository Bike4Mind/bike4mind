import type { AccessContext, IAdminSettingsRepository, IDataLakeDocument } from '@bike4mind/common';
import { classifyLakeAccess, type LakeAccessArm } from './classifyLakeAccess';
import type { LakeGrant } from './manageRule';

/** The platform cutover flag governing whether read-grant resolution is enforced or report-only. */
export const ENFORCE_LAKE_READ_GRANTS_KEY = 'EnforceLakeReadGrants' as const;

/** Minimal diagnostic sink - a structural subset of the app Logger, so no dependency is added here. */
export interface LakeAccessLogger {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
}

/**
 * The NEW explicit read-grant arm (#1673): true when the caller's USER principal holds ANY active
 * grant row on this lake. The grant row IS the authorization - it needs none of the org/gate
 * constraints (the analog of the createdByUserId owner bypass, extended to a delegated
 * reader/curator/owner) and it bypasses Private-by-default. Owner and curator already pass the legacy
 * `owner-admin` arm (via canManageLake), so the ONLY outcome this flips from the legacy gate is a
 * `reader`-role grant - exactly the gap #1673 closes. `grants` is pre-filtered to ACTIVE (expiry) by
 * the caller, so a lapsed grant never reaches here.
 *
 * User-principal only in v1: org-principal read grants are a deferred Lane B follow-up (see
 * grantedLakeIdsFor). Membership never crosses orgs (epic decision 12) - enforced at grant-WRITE
 * time, so an existing row is honored unconditionally at read time.
 */
export function resolveUserReadGrant(ctx: Pick<AccessContext, 'userId'>, grants: readonly LakeGrant[]): boolean {
  return !!ctx.userId && grants.some(g => g.principalType === 'user' && g.principalId === ctx.userId);
}

/** The decomposed read decision: the legacy arm, the new read-grant arm, and what each would allow. */
export interface LakeReadAccessDecision {
  /** The ENFORCED decision: the legacy decision in report-only, the grant-resolved decision when enforcing. */
  allowed: boolean;
  /** What the legacy five-arm gate decided (the report-only fallback). */
  legacyAllowed: boolean;
  /** Which legacy arm produced `legacyAllowed`. */
  legacyArm: LakeAccessArm;
  /** Whether an explicit user read grant admits the caller. */
  readGrantAllows: boolean;
  /** legacyAllowed OR readGrantAllows - the decision once the cutover is enforced. */
  resolvedAllowed: boolean;
  /** True when the read grant CHANGES the legacy outcome (always deny -> allow: a reader grant). */
  diverges: boolean;
  /** Whether this decision was enforced (`allowed === resolvedAllowed`) or report-only. */
  enforced: boolean;
}

/**
 * Resolve read access with the ephemeral membership view layered onto the legacy gate. In report-only
 * mode (`enforceReadGrants: false`) the ENFORCED decision stays the legacy one, so nothing changes for
 * users while the cutover is observed; the caller logs `diverges` to build the expected-grant-set diff.
 * Once enforced, a persisted read grant admits the caller. Pure/sync - the same seam as classifyLakeAccess.
 */
export function resolveLakeReadAccess(
  lake: Pick<
    IDataLakeDocument,
    'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
  >,
  ctx: AccessContext,
  grants: readonly LakeGrant[] = [],
  opts: { enforceReadGrants: boolean }
): LakeReadAccessDecision {
  const legacy = classifyLakeAccess(lake, ctx, grants);
  const readGrantAllows = resolveUserReadGrant(ctx, grants);
  const resolvedAllowed = legacy.allowed || readGrantAllows;
  return {
    allowed: opts.enforceReadGrants ? resolvedAllowed : legacy.allowed,
    legacyAllowed: legacy.allowed,
    legacyArm: legacy.arm,
    readGrantAllows,
    resolvedAllowed,
    diverges: resolvedAllowed !== legacy.allowed,
    enforced: opts.enforceReadGrants,
  };
}

/**
 * The platform-level read-grant cutover flag. Platform altitude on purpose: this is a one-time
 * migration cutover for the whole install, not a per-lake operational lever. NEVER throws - an
 * unwired repo OR a failed read degrades to `false` (report-only / legacy), because a failed read is
 * not a "yes": collapsing it into enforce would silently widen access on a transient glitch. The warn
 * is the diagnostic that tells "flag was off" apart from "read failed" for a smoke test.
 */
export async function resolveEnforceReadGrants(
  settings: Pick<IAdminSettingsRepository, 'getSettingsValue'> | undefined,
  logger?: LakeAccessLogger
): Promise<boolean> {
  if (!settings) return false;
  try {
    return (await settings.getSettingsValue(ENFORCE_LAKE_READ_GRANTS_KEY)) === true;
  } catch (err) {
    logger?.warn?.('[lakeReadGrantCutover] enforce-flag read failed; treating as report-only', err);
    return false;
  }
}
