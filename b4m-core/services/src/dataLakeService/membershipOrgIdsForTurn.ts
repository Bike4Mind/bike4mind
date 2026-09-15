import type { IOrganizationRepository } from '@bike4mind/common';
import { createScopedAsyncMemo } from './scopedAsyncMemo';

/** Backing store for `membershipOrgIdsForTurn`. Keyed on the caller, its only varying argument. */
const membershipByTurn = createScopedAsyncMemo<string[]>();

/**
 * The caller's authoritative org membership (owner + `users[]` ACL, #1674), resolved at most ONCE
 * per turn. Both lake-access resolvers need it and BOTH run per TOOL CALL - `getDynamicDataLakeAccess`
 * for retrieval and `getAccessibleDataLakePrompts` for injection - so a turn that grounds and then
 * calls two knowledge tools issued this read once per resolver per call. Sharing one memo (rather
 * than one per resolver) is what makes it a single read for the whole turn: the two resolvers agree
 * on what "my orgs" means by contract already, and now by identity.
 *
 * `turnScope` must be an object whose lifetime IS the turn - the shared `ToolContext`, built once
 * per request in `generateTools`. The repo is NOT in the key (an object cannot be), so the scope has
 * to be the object that owns it; every caller passes `context` and reads the repo off `context.db`.
 *
 * THE PROPAGATE-NOT-SWALLOW CONTRACT AT BOTH CALL SITES IS PRESERVED, and it is per ATTEMPT: a
 * rejection is evicted rather than cached, so the next tool call re-reads and throws again instead
 * of inheriting a "member of nothing" that both resolvers would read as a settled deny. What IS
 * per-turn is the successful answer - a membership change mid-turn is not picked up, matching the
 * grant reach snapshot resolved alongside it (see `grantedLakeReachForTurn`).
 *
 * Callers keep their own fail-closed check that the projected reader exists: an unwired host must
 * still get the legible error naming the missing adapter, not a TypeError from inside a memo.
 */
export const membershipOrgIdsForTurn = (
  turnScope: object,
  userId: string,
  organizations: Pick<IOrganizationRepository, 'findMembershipOrgIds'>
): Promise<string[]> => membershipByTurn(turnScope, userId, () => organizations.findMembershipOrgIds(userId));
