import type { IDataLakeDocument } from '@bike4mind/common';
import { normalizeEntitlementKey } from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils';

/** The lake fields a widening decision reads: the two gates, plus what the lake falls back to without them. */
export type GatedLake = Pick<
  IDataLakeDocument,
  'organizationId' | 'isPublic' | 'requiredUserTag' | 'requiredEntitlement'
>;

/** A gate write, in `UpdateDataLakeRequestInput` terms: absent means unchanged, '' means clear. */
export type GateWrites = Partial<Pick<IDataLakeDocument, 'requiredUserTag' | 'requiredEntitlement'>>;

const GATE_FIELDS = ['requiredUserTag', 'requiredEntitlement'] as const;

/**
 * Normalizes a gate value the way the READ path does, so an edit that cannot move a single reader
 * is not mistaken for one that can: `lakeMatchesAccess` lowercases `requiredUserTag` and runs
 * `requiredEntitlement` through `normalizeEntitlementKey`, and both spellings of unset ('' and
 * absent) admit the same population.
 */
const normalizeGate = (field: (typeof GATE_FIELDS)[number], value: string | undefined): string =>
  !value ? '' : field === 'requiredEntitlement' ? normalizeEntitlementKey(value) : value.toLowerCase();

/**
 * The lake's gate as the set of arms `lakeMatchesAccess` would OR together, each tagged with the
 * field it came from so a tag and an entitlement that happen to share a spelling stay distinct.
 * Empty means ungated.
 */
const gateSet = (lake: Pick<GatedLake, 'requiredUserTag' | 'requiredEntitlement'>): string[] =>
  GATE_FIELDS.map(field => ({ field, value: normalizeGate(field, lake[field]) }))
    .filter(arm => arm.value !== '')
    .map(arm => `${arm.field}:${arm.value}`);

/**
 * Does this gate write admit a reader the lake's current configuration excludes?
 *
 * The answer inverts on the lake's visibility, because a gate does not describe a population on its
 * own - it selects from whatever arm the lake would otherwise land on in `classifyLakeAccess`:
 *
 * - PRIVATE and org-less: ungated means the `private-deny` arm, owner-only. GAINING a gate moves the
 *   lake onto the requirement any-of, where every holder of that tag/entitlement reads it app-wide
 *   and across orgs. So here adding widens and clearing narrows - the reverse of the intuition the
 *   word "gate" invites, and the exposure this rule exists to stop.
 * - ORG-SCOPED: org membership is a hard prerequisite evaluated before the any-of, so a gate only
 *   ever selects a subset of the org. Adding narrows; clearing opens the lake to the whole org.
 * - PUBLIC: readable app-wide already, with the gate respected as defense in depth. Adding narrows
 *   (and is refused outright upstream); clearing restores the readership the lake already declares.
 *
 * Swapping one non-empty gate value for another admits holders of the new value who were excluded by
 * the old one, whatever the visibility.
 *
 * Pure and sync so it can be tested against the arms directly; the authority decision it feeds lives
 * in `updateDataLake`.
 */
export function gateWriteWidensReadership(existing: GatedLake, writes: GateWrites): boolean {
  // An ungated lake that falls back to owner-only is the one shape where a gate ADDS readers.
  const ungatedIsOwnerOnly = !normalizeId(existing.organizationId) && !existing.isPublic;

  // Graded on the resulting gate SET, not field by field. `lakeMatchesAccess` is an any-of, so the
  // two fields are arms of one predicate rather than independent switches: on a lake gated by both
  // a tag and an entitlement, clearing either one removes an arm and strictly narrows readership,
  // which a per-field view reads as "a gate was cleared" and refuses.
  const before = gateSet(existing);
  const after = gateSet({
    requiredUserTag: writes.requiredUserTag === undefined ? existing.requiredUserTag : writes.requiredUserTag,
    requiredEntitlement:
      writes.requiredEntitlement === undefined ? existing.requiredEntitlement : writes.requiredEntitlement,
  });

  // Losing the last arm: the lake falls back to its visibility. Owner-only for a private, org-less
  // lake (narrower), the whole org or the whole app otherwise (wider).
  if (after.length === 0) return before.length > 0 && !ungatedIsOwnerOnly;

  // Gaining the first arm: the mirror case. Only a private, org-less lake moves OFF owner-only.
  if (before.length === 0) return ungatedIsOwnerOnly;

  // Arm set changed while still gated. An arm nobody had before admits a population that could not
  // read the lake, whatever the visibility; dropping arms only ever removes readers.
  return after.some(arm => !before.includes(arm));
}
