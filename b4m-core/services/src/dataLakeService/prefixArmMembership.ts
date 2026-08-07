import type { IDataLakeRepository } from '@bike4mind/common';
import { isReservedTagPrefix, normalizeTagPrefix, prefixArmTagNames } from '@bike4mind/common';
import type { MembershipLake } from './lakeMembership';

export interface PrefixArmChange {
  lake: MembershipLake;
  /**
   * The stored tag names that were this lake's ONLY membership signal. A leave's caller force-
   * carries these into the persisted tag array so `removeFileFromLake` (which checks membership
   * against the STORED document) still sees the file as a member when it runs.
   */
  signalTags: string[];
}

export interface PrefixArmAdapters {
  db: { dataLakes: Pick<IDataLakeRepository, 'find'> };
  /**
   * Pre-resolved candidates, so a BATCH caller (toggleTags, the bulk tag doors) issues one query
   * for many files instead of one per file. Membership is re-asserted per lake against
   * `fileOwnerUserId` below, so an over-broad candidate set is safe - a caller may pass every
   * lake for every owner touched by the batch.
   */
  candidateLakes?: readonly MembershipLake[];
}

/**
 * Loose, CASE-INSENSITIVE cousin of `prefixArmTagNames`, for the bulk tag-rename/delete doors'
 * "should this lake's stats be recomputed" decision - not a membership or gating check. Those
 * doors' underlying writes (`removeTagByUserId`/`updateTagsByUserId`) match tag names
 * case-INSENSITIVELY, so a differently-cased name than the one the caller supplied can still be
 * the thing that actually got stripped or renamed. The true (case-sensitive) membership rule
 * would miss that and skip a recompute a real signal change needs. Erring inclusive is safe here:
 * `recomputeLakeStats` is idempotent, so a false-positive match just costs one harmless extra
 * recompute.
 */
export const couldMatchTagPrefixArmLoosely = (name: string, fileTagPrefix: string | undefined | null): boolean => {
  const prefix = normalizeTagPrefix(fileTagPrefix);
  if (!prefix || isReservedTagPrefix(prefix)) return false;
  return name.toLowerCase().startsWith(prefix.toLowerCase());
};

/**
 * One query for a whole batch: every lake whose prefix arm could reach any of these file owners'
 * files. Owner-anchored because the read arm is (`buildDataLakeMembershipFilter`), never the
 * acting user - a shared-edit file's membership rides on who OWNS it, not who is editing it.
 */
export const loadPrefixArmCandidateLakes = async (
  fileOwnerUserIds: readonly (string | undefined | null)[],
  { db }: { db: { dataLakes: Pick<IDataLakeRepository, 'find'> } }
): Promise<MembershipLake[]> => {
  const ids = [...new Set(fileOwnerUserIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return [];
  return (await db.dataLakes.find({ createdByUserId: { $in: ids } })) as MembershipLake[];
};

interface PrefixArmDiffInput {
  /** The FILE's owner. The read arm anchors the prefix arm here, NOT the acting user. */
  fileOwnerUserId: string | undefined | null;
  /** Tag names stored on the file BEFORE this write. */
  currentTagNames: readonly string[];
  /** Tag names the file will hold AFTER this write settles. */
  resultingTagNames: readonly string[];
}

/**
 * Fetches candidates when none were supplied, and short-circuits the query entirely when nothing
 * dropped or added could carry a prefix arm - every usable prefix ends in ':' (`normalizeTagPrefix`),
 * so any name that could match one necessarily contains a colon.
 */
const resolveCandidates = async (
  { fileOwnerUserId, currentTagNames, resultingTagNames }: PrefixArmDiffInput,
  { db, candidateLakes }: PrefixArmAdapters
): Promise<MembershipLake[]> => {
  const current = new Set(currentTagNames);
  const resulting = new Set(resultingTagNames);
  const changed = [...current, ...resulting].filter(name => !(current.has(name) && resulting.has(name)));
  if (!changed.some(name => name.includes(':'))) return [];
  if (candidateLakes) return candidateLakes.filter(lake => lake.createdByUserId === fileOwnerUserId);
  return loadPrefixArmCandidateLakes([fileOwnerUserId], { db });
};

export interface PrefixArmChanges {
  /**
   * Every lake a file is about to LEAVE by losing its only prefix-arm signal - the gap #1263 is
   * about. Callers gate each one with `canManageLake` + `assertLakeWritable` before treating it
   * as authorized, exactly like the existing meta-tag leave path - a prefix-arm leave is the same
   * security-relevant transition (a file exiting lake membership) and gets the same gate.
   */
  leaves: PrefixArmChange[];
  /**
   * The mirror case: every lake a file is about to JOIN by newly satisfying a prefix arm it did
   * not satisfy before. The MEMBERSHIP itself needs no gate - tagging your own file with your own
   * lake's folder tag is today's already-accepted "automatic membership" model (the fallback
   * tagger stamps the same content tags with no permission check) - but callers gate the
   * `recomputeLakeStats` call this feeds with `canManageLake` anyway: that recompute also flips a
   * draft lake to active (a one-way, publication-visibility change), and `fileOwnerUserId` above
   * is the FILE's owner, not necessarily the acting user - an unrelated file-share recipient must
   * not be able to force-publish a lake they do not manage.
   */
  joins: PrefixArmChange[];
}

/**
 * Classifies every candidate lake as a LEAVE, a JOIN, or unaffected, in one pass over one
 * resolved candidate set - `findPrefixArmLeaves`/`findPrefixArmJoins` used to be two separate
 * functions that each independently resolved candidates and re-walked them, doubling both the
 * query and the per-lake work for every caller (all of which need both anyway).
 *
 * A lake is a candidate at all only when: it is owned by the file's owner (the read arm's
 * anchor); and its meta-tag is absent both before and after (a meta-tag-driven join/leave is the
 * existing, already-gated path in `reconcileLakeTags`/`toggleTags` - this helper must not
 * double-handle it). From there: CURRENT satisfies + RESULTING does not is a leave; the reverse
 * is a join; anything else is unaffected.
 */
export const findPrefixArmChanges = async (
  input: PrefixArmDiffInput,
  adapters: PrefixArmAdapters
): Promise<PrefixArmChanges> => {
  const candidates = await resolveCandidates(input, adapters);
  const leaves: PrefixArmChange[] = [];
  const joins: PrefixArmChange[] = [];
  for (const lake of candidates) {
    if (lake.createdByUserId !== input.fileOwnerUserId) continue;
    if (input.currentTagNames.includes(lake.datalakeTag) || input.resultingTagNames.includes(lake.datalakeTag)) {
      continue;
    }
    const currentSignal = prefixArmTagNames(input.currentTagNames, lake.fileTagPrefix);
    const resultingSignal = prefixArmTagNames(input.resultingTagNames, lake.fileTagPrefix);
    if (currentSignal.length > 0 && resultingSignal.length === 0) {
      leaves.push({ lake, signalTags: currentSignal });
    } else if (currentSignal.length === 0 && resultingSignal.length > 0) {
      joins.push({ lake, signalTags: resultingSignal });
    }
  }
  return { leaves, joins };
};
