/**
 * PR report generator - configuration-time validation of the bucket specs.
 *
 * Everything checked here fails SILENTLY and DAILY if left unchecked, and none of
 * it is catchable by a per-report assertion - from inside a report, a blanket-ping
 * of the whole pool looks exactly like a legitimately open gate. So these run at
 * settings-save and at startup, where a typo is still cheap.
 */

import type { Bucket, BucketSpecs, IdentityLookup, PullRequest } from './types';

export interface BucketSpecValidationError {
  bucket: Bucket;
  reason: string;
  /**
   * 'blocking' errors are structural (no catch-all, duplicate order, a roster with no
   * roleKey or no specificOwner) and must fail the generate. 'advisory' covers the one
   * recoverable case - a roster whose roleKey has no identity-map entry - which the
   * renderer already degrades to "no pool mention" (see buildReport). An unfilled or
   * partial identity map is a legitimate configuration, so that case is surfaced as a
   * warning rather than blocking a digest the admin may not want pool pings on anyway.
   */
  severity: 'blocking' | 'advisory';
}

/**
 * Tag helpers so a push site cannot pair a reason with the wrong severity by hand. The
 * severity travels with the KIND of check, not with the individual call: structural
 * failures are blocking, an unmapped role key is advisory.
 */
const blockingError = (bucket: Bucket, reason: string): BucketSpecValidationError => ({
  bucket,
  reason,
  severity: 'blocking',
});
const advisoryError = (bucket: Bucket, reason: string): BucketSpecValidationError => ({
  bucket,
  reason,
  severity: 'advisory',
});

/**
 * Validate the specs against the resolved identity lookup.
 *
 * @returns the errors found; empty means valid. Callers reject the settings save
 *   (or refuse to boot) rather than rendering a report from invalid specs.
 */
export function validateBucketSpecs(specs: BucketSpecs, lookup: IdentityLookup): BucketSpecValidationError[] {
  const errors: BucketSpecValidationError[] = [];
  const buckets = Object.keys(specs) as Bucket[];

  // Totality. Without a catch-all, an unmatched PR has nowhere to go and the
  // report's "no open PR silently vanishes" promise is void.
  if (!buckets.some(bucket => specs[bucket].role === 'catchAll')) {
    errors.push(blockingError('none', 'no bucket has role "catchAll" - classification would not be total'));
  }

  // Duplicate orders make precedence - and therefore categorization - depend on
  // object key order, which is not a contract worth relying on.
  const seenOrders = new Map<number, Bucket>();
  for (const bucket of buckets) {
    const existing = seenOrders.get(specs[bucket].order);
    if (existing) {
      errors.push(
        blockingError(
          bucket,
          `order ${specs[bucket].order} is already used by "${existing}" - precedence would be ambiguous`
        )
      );
    }
    seenOrders.set(specs[bucket].order, bucket);
  }

  for (const bucket of buckets) {
    const spec = specs[bucket];
    if (spec.mention !== 'roleRoster') continue;

    // A typo'd role prefix produces NO mention rather than an error, so the pool
    // is simply never told anything. This check is the whole mitigation when the
    // map is held as structured config with no free-text parser to report on.
    if (!spec.roleKey) {
      errors.push(blockingError(bucket, 'mention is "roleRoster" but no roleKey is set'));
    } else if (!lookup[spec.roleKey.toLowerCase()]) {
      // ADVISORY, not blocking: the renderer already omits the pool mention for an
      // unresolved roleKey (buildReport), so a blank or partial identity map still
      // produces a valid digest. Surfaced as a warning so the admin knows the pool
      // will not be pinged until they add the entry.
      errors.push(
        advisoryError(
          bucket,
          `roleKey "${spec.roleKey}" has no entry in the identity map - the roster will post without an @-mention until you add it`
        )
      );
    }

    // No implicit default, deliberately. 'requestedReviewer' is the default any
    // implementation falls into - first in the union, right for the gates written
    // first - and it is wrong for every non-review bucket, where review has
    // already finished so the list is empty by construction. That is an
    // always-open gate that blanket-pings the entire pool on every digest.
    if (!spec.specificOwner) {
      errors.push(
        blockingError(
          bucket,
          'mention is "roleRoster" but no specificOwner is set - defaulting it would blanket-ping the whole pool on every report'
        )
      );
    }
  }

  return errors;
}

/**
 * Assert that the PR field each roster bucket's gate reads is actually POPULATED
 * by the provider.
 *
 * ABSENT IS NOT EMPTY. `requestedReviewerLogins` is optional in the contract, so a
 * provider - or a query that never selected reviewers - leaving it undefined makes
 * every PR read as "nobody specific", which is the same daily blanket-ping reached
 * from the other side. An undefined field on a bucket that names it is a
 * configuration error, never an open gate.
 *
 * Runs on the generate path because it needs real PRs to inspect; it fails the
 * generate rather than posting a report whose rosters are meaningless.
 *
 * @returns the errors found; empty means the fields are populated.
 */
export function validateSpecificOwnerFieldsPopulated(
  specs: BucketSpecs,
  prs: PullRequest[]
): BucketSpecValidationError[] {
  if (!prs.length) return [];

  const errors: BucketSpecValidationError[] = [];

  for (const bucket of Object.keys(specs) as Bucket[]) {
    const spec = specs[bucket];
    if (spec.mention !== 'roleRoster') continue;

    if (spec.specificOwner === 'requestedReviewer') {
      // Undefined on EVERY PR means the field was never selected. A mix is normal
      // (GitHub returns `[]` for a PR with nobody requested), so only a total
      // absence is diagnostic.
      if (prs.every(pr => pr.requestedReviewerLogins === undefined)) {
        errors.push(
          blockingError(
            bucket,
            'specificOwner is "requestedReviewer" but no PR carries requestedReviewerLogins - the provider or query does not populate it, so the roster gate would be permanently open'
          )
        );
      }
    }
  }

  return errors;
}
