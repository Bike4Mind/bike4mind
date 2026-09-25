import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository } from '@bike4mind/database';
import { userRepository } from '@bike4mind/database/auth';
import { orgAclRowConfersMembership } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import mailer from './mailer';

/**
 * Reads the departing member's surviving personal-lake shares and best-effort emails their owners,
 * scoped to owners who are still current members of `organization` - see
 * `reportKeptPersonalLakeShares` for why a cross-tenant owner is excluded rather than merely
 * unaddressed. Call after the departure's transaction commits - personal-lake grants are untouched
 * by it, so a post-commit read sees the same result, and calling once per route means a retried
 * transaction cannot mail twice. Never throws into the route: a failure in the report read is
 * logged and the count is reported as unavailable (`null`), distinct from the zero-shares-kept case.
 */
export async function reportAndNotifyKeptPersonalLakeShares(
  departedUserId: string,
  organization: {
    id: string;
    name: string;
    userId: string;
    users?: ReadonlyArray<{ userId: string; permissions?: readonly string[] | null }> | null;
  },
  logger?: Logger
): Promise<number | null> {
  // Authorization/disclosure, not report scoping - so this is the ACL arm of `findMemberUserIds`
  // only (OrgMemberPopulation), never its stamp arm. A `User.organizationId`-stamped-but-ACL-less
  // user is not an authoritative member and must not be treated as a safe email recipient. Same
  // cross-tenant-disclosure concern as `assembleLakeAccessView.ts`'s `userDisplayName` and
  // `lakeGrantWriteRule.ts`'s USER-principal carve-out.
  // String() for the same reason findMemberUserIds does it: these ids meet grant principalIds,
  // which are strings, and a type mismatch here would fail closed and silently mail nobody.
  const orgMemberUserIds = [
    ...new Set([
      String(organization.userId),
      ...(organization.users ?? []).filter(orgAclRowConfersMembership).map(u => String(u.userId)),
    ]),
  ];

  let shares: dataLakeService.KeptPersonalLakeShares;
  try {
    shares = await dataLakeService.reportKeptPersonalLakeShares(departedUserId, orgMemberUserIds, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
      logger,
    });
  } catch (err) {
    const error = logger?.error ? logger.error.bind(logger) : console.error;
    error('[dataLakes] kept-personal-lake-share report failed', {
      departedUserId,
      organizationName: organization.name,
      error: String(err),
    });
    return null;
  }

  await dataLakeService.notifyKeptPersonalLakeShares(
    shares,
    { departedUserId, organizationName: organization.name, appUrl: process.env.APP_URL },
    { db: { users: userRepository }, mailer, logger }
  );

  return shares.lakeCount;
}
