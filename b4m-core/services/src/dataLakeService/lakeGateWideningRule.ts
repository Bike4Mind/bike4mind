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
 * Compares two gate values the way the READ path does, so an edit that cannot move a single reader
 * is not mistaken for one that can: `lakeMatchesAccess` lowercases `requiredUserTag` and runs
 * `requiredEntitlement` through `normalizeEntitlementKey`, and both spellings of unset ('' and
 * absent) admit the same population.
 */
const sameGate = (field: (typeof GATE_FIELDS)[number], a: string | undefined, b: string | undefined): boolean => {
  const norm = (v: string | undefined) =>
    !v ? '' : field === 'requiredEntitlement' ? normalizeEntitlementKey(v) : v.toLowerCase();
  return norm(a) === norm(b);
};

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

  return GATE_FIELDS.some(field => {
    const next = writes[field];
    if (next === undefined) return false;
    const current = existing[field];
    if (sameGate(field, current, next)) return false;
    if (!next) return !ungatedIsOwnerOnly;
    if (!current) return ungatedIsOwnerOnly;
    return true;
  });
}
