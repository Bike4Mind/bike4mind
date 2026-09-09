import { createHash } from 'crypto';
import { buildDuplicateGroups } from '@bike4mind/common';
import type {
  DuplicateGroup,
  FabFileChunkPolicyConflict,
  FabFileSourceType,
  LakeMembershipMemberInput,
  SourceIdentityTier,
} from '@bike4mind/common';

/**
 * The lake admission contract (#1679): the shared idea of "done" every ingestion door converges on,
 * evaluated at the ONE checkpoint every door's file already flows through - the chunk pipeline. It
 * does not funnel the structurally-different doors through one create call; it (1) fingerprints the
 * extracted text (`computeServerTextHash`) and (2) derives the member's retrievability against the
 * applicable chunk policy (`deriveAdmissionStatus`). Provenance is carried by `FabFile.sourceType`.
 *
 * It also asks the question the two derivations above cannot (#2238): does a sibling in this lake
 * already claim this document's identity - see `detectSameIdentityAdmission`. That check is keyed on
 * SOURCE identity, never on `serverTextHash`: the case a corpus assembled over time actually produces
 * is two REVISIONS of one document, whose text differs by definition, so a hash would only ever catch
 * an exact re-upload.
 *
 * This module stays REPORT-ONLY, and deliberately so: it runs POST-chunk, by which point the file is
 * already a member, and the contract governs admission rather than eviction. The hard gate reads the
 * same `chunkPolicyConflict` comparison at the MEMBERSHIP WRITE instead - see `lakeAdmissionGate.ts`
 * (#1680), which refuses a new membership before the content is ever ingested. Report-only extends to
 * the duplicate check on purpose: a same-named upload is very often a legitimate revision, which is
 * precisely the pattern that produced the duplicated corpora this work came from, so a gate that
 * refused one would have blocked the CORRECTED copies from ever being uploaded.
 */

/** Whether an admitted member's chunks honor every lake policy that applies to it. */
export type AdmissionStatus = 'admitted' | 'quarantined';

/**
 * Collapse insignificant text differences so the hash is a "materially changed" signal, not a
 * byte-identity check: NFC, fold Unicode whitespace runs to one space, trim. Same document differing
 * only in wrapping/trailing whitespace hashes equal; a real content change does not.
 */
export function normalizeTextForHash(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Server-verified SHA-256 (hex) over a file's CANONICAL EXTRACTED TEXT - the text as extracted from
 * the document (SmartChunker.getExtractedText), NOT the chunker's output. That distinction is load-
 * bearing: chunk boundaries, structural JSON/CSV/XLSX envelopes, and data-URL redaction all move with
 * chunkTokenLimit/model, so hashing chunk output would make two byte-identical files under different
 * chunk policies fingerprint differently - the exact false "materially changed" signal this field
 * exists to be immune to. Trustworthy for #1671 dedup where the client byte-hash `contentHash` is not
 * (unverified, absent on connector files). Undefined when there is no extractable text, so a caller
 * never records an empty-string hash that collides across every text-less file.
 */
export function computeServerTextHash(extractedText: string | undefined): string | undefined {
  if (!extractedText) return undefined;
  const normalized = normalizeTextForHash(extractedText);
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The admission decision, derived from the cross-lake chunk-policy conflict the checkpoint already
 * computes (#1662): a member with an unresolved conflict cannot honor a lake it belongs to, so it is
 * `quarantined`; otherwise it is `admitted`. Derived rather than stored as a second field so the
 * "cannot be honored" truth lives in exactly one place (`chunkPolicyConflict`) - the same place
 * `lakeAdmissionGate` enforces from, so the report and the gate cannot disagree.
 */
export function deriveAdmissionStatus(conflict: FabFileChunkPolicyConflict | null): AdmissionStatus {
  return conflict ? 'quarantined' : 'admitted';
}

/** Human-/log-readable door label for a member's provenance; `unknown` when a door left it unset. */
export function admissionDoorLabel(sourceType: FabFileSourceType | undefined): string {
  return sourceType ?? 'unknown';
}

/**
 * A sibling in the same lake already claims this document's identity.
 *
 * `group` is the whole refined same-name group, admitted member included - not just the match. That
 * is what the recorded ruling has to be stamped over: `groupIdentity` is computed from a group's
 * members, and `planMembershipRepair` recomputes it from the group the membership report builds, so
 * a decision stamped over a narrower set would never settle anything and the owner would be asked
 * again on the next run.
 */
export interface SameIdentityAdmission {
  /** Which identity signal matched. `fileName` is the weak tier and can be wrong - see sourceIdentity.ts. */
  tier: SourceIdentityTier;
  group: DuplicateGroup;
}

/**
 * Whether an admitted member is another generation of a document this lake already holds. Pure; the
 * caller owes the lake-scoped sibling set (`findLakeMemberSiblingsByFileName`).
 *
 * Graded through `buildDuplicateGroups` rather than by comparing keys here, so the offer made at the
 * door and the plan the owner sees afterwards cannot disagree about the same pair - one function
 * decides both what "the same document" means and how confidently (`bucket`).
 *
 * Null when the candidate is not IN the refined group, which covers two distinct cases and both are
 * correct as "no offer": it shares a name with nobody, or it shares a name with siblings whose
 * identity key differs from the group's newest member. The second is the false pair the bare
 * file-name tier is known to produce - two unrelated `README.md` files - and offering to collapse it
 * is the one error this check cannot afford.
 *
 * `siblings` must exclude the candidate itself; passing it twice would report a group of one member
 * duplicated, which `buildDuplicateGroups` cannot detect (the two rows carry the same `fabFileId`
 * but are distinct array entries).
 */
export function detectSameIdentityAdmission(
  candidate: LakeMembershipMemberInput,
  siblings: readonly LakeMembershipMemberInput[]
): SameIdentityAdmission | null {
  if (!candidate.fileName) return null;
  const { groups } = buildDuplicateGroups([candidate, ...siblings]);
  // At most one group per file name, by construction - see buildDuplicateGroups.
  const group = groups.find(g => g.fileName === candidate.fileName);
  if (!group?.members.some(m => m.fabFileId === candidate.fabFileId)) return null;
  return { tier: group.tier, group };
}

/**
 * The log line for a detected same-identity admission. Names the tier and every member id, because
 * the file-name tier can be wrong and a reader can only judge that from the pair plus the tier - the
 * same discipline `formatSupersededSample` keeps for the retrieval-time collapse.
 *
 * Deliberately does NOT include the file name: this reaches the ingestion logs, where a name is
 * uploader content, and the ids are enough to fetch the pair.
 */
export function describeSameIdentityAdmission(lakeId: string, found: SameIdentityAdmission): string {
  const ids = found.group.members.map(m => m.fabFileId).join(', ');
  return (
    `[admission] lake ${lakeId} already holds this document: ${found.group.memberCount} member(s) ` +
    `matched by ${found.tier}, identity ${found.group.bucket} [${ids}]`
  );
}
