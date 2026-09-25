import { sourceIdentityKeyFor, type LakeSupersession, type SourceIdentityTier } from '@bike4mind/common';
import { attributeFileToLakeIds, type AttributableLake } from './attributeAccessedLakes';
import { toSingleLine } from './renderDataLakePromptBlock';

/**
 * Content that is in scope, authorized and servable, but SUPERSEDED: an older generation of a
 * document the same lake also holds a newer generation of (a re-upload, a Drive sync, a migration).
 *
 * Ranking both generations is worse than ranking one. They are near-duplicates by construction, so
 * they crowd each other into the top-K, spend the chunk budget twice, and hand the model two
 * versions of the same passage with nothing to say which one is current - the case where a
 * confidently wrong answer comes from a corpus that technically contained the right one.
 *
 * The identity key is `sourceIdentityKeyFor` (common/constants/sourceIdentity.ts), shared with the
 * membership report's duplicate grouping and the admission checkpoint's same-identity detection.
 * Read that module for why the key is PATH identity and never a content hash.
 *
 * Because the weakest tier is a bare filename, this can be wrong: two genuinely different documents
 * named `README.md` in one lake, neither carrying a `relativePath`, collapse to one. That is
 * acceptable only because suppression is RECOVERABLE - the member leaves ranking, not the corpus,
 * and `retrieve_knowledge_content` (knowledgeBaseRetrieve) still reaches it by id or name, since
 * that tool does not apply this partition. Which is why the report below names suppressed ids and
 * the tier that suppressed them rather than only counting them: a bad collapse has to be
 * diagnosable from a transcript alone.
 *
 * Attribution reaches prefix-only members, which is why `userId` is part of the input: a dynamic
 * lake's content-tag prefix is user-chosen, so it identifies a lake only when conjoined with the
 * lake creator's ownership of the file - the same conjunction `buildDataLakeMembershipFilter` uses
 * to decide membership for the browse and every lifecycle write. Dropping `userId` from a builder
 * therefore does not merely lose a field: it silently narrows the collapse back to meta-tagged
 * members, on lakes whose members are largely prefix-only.
 *
 * REMAINING GAP, and the one to check before reading a collapse count as evidence of anything: a
 * prefix-only member the creator does NOT own - an admin's upload into someone else's lake is the
 * documented case - is not a member by that predicate either, so it still groups only with itself.
 * That is deliberate rather than missing: attribution here must not claim a membership the lake's
 * own delete and browse paths would deny. Such a member cannot be collapsed, and cannot suppress.
 */

/** How many suppressed files to name, so a caller can act without dumping the lake. */
const SAMPLE_CAP = 5;

/**
 * A ruling a curator made by hand, reviewing a detected corpus problem. Above every derived tier
 * and never produced by `sourceIdentityKeyFor`: the derived tiers all answer "do these two look
 * like the same source document", and a curator is answering a different question - which of two
 * documents that CONTRADICT each other is current. Two such documents routinely share no identity
 * key at all, which is why no derived tier can express the ruling.
 */
export const CURATOR_SUPERSESSION_TIER = 'curator' as const;

/**
 * Which signal produced a suppression, most to least trustworthy. Reported per collapse because
 * the weakest tier is the one that can be wrong (see the module comment).
 *
 * The derived tiers are `sourceIdentityKeyFor`'s own, aliased rather than re-declared so the two
 * cannot drift; `curator` is this module's, and sits above all of them.
 */
export type SupersessionTier = SourceIdentityTier | typeof CURATOR_SUPERSESSION_TIER;

/** The per-file facts the collapse reads. A subset of what `RankableFile` already carries. */
export type SupersedableFile = {
  id: string;
  fileName?: string;
  fileTags?: string[];
  /** The file's owner. Enables the dynamic-lake prefix arm of attribution - see the module comment. */
  userId?: string;
  /** Populated for folder uploads and Drive ingest; absent on a plain single-file re-upload. */
  relativePath?: string;
  /** Drive ingest only - its own doc comment calls it the stable dedup key within a lake. */
  driveFileId?: string;
  createdAt?: Date | string | null;
  /**
   * Curator rulings, one per lake (IFabFile.supersededInLakes). Read straight off the file row the
   * ranking path already loaded, deliberately: a separate collection would put a query on the hot
   * retrieval path for a fact that is almost always absent.
   */
  supersededInLakes?: LakeSupersession[];
};

export interface SupersessionReport {
  count: number;
  /**
   * Named suppressed files, capped; `count` above is always exact. `supersededBy` is the winner
   * that kept the key, so a reader can fetch the pair and judge the collapse.
   */
  sample: { fileId: string; fileName?: string; tier: SupersessionTier; supersededBy: string }[];
  /** True when anything was suppressed - the flag a consumer branches on. */
  partial: boolean;
}

export function emptySupersessionReport(): SupersessionReport {
  return { count: 0, sample: [], partial: false };
}

/** Suppressed member paired with the generation that displaced it. */
export type SupersededEntry<T extends SupersedableFile = SupersedableFile> = {
  file: T;
  tier: SupersessionTier;
  supersededBy: string;
};

/** Missing timestamps sort oldest, so an undated member never displaces a dated sibling. */
const createdAtMillis = (file: SupersedableFile): number => {
  if (!file.createdAt) return -Infinity;
  const ms = new Date(file.createdAt).getTime();
  return Number.isFinite(ms) ? ms : -Infinity;
};

/**
 * Newest wins; equal timestamps fall to ascending id so the choice never depends on scope order.
 * Ascending id is arbitrary but FIXED, which is the property that matters. Note it keeps the older
 * row when both members are undated, since ObjectId hex is time-ordered - reachable only by legacy
 * rows inserted past `timestamps: true`, and still deterministic.
 */
function winsOver(candidate: SupersedableFile, incumbent: SupersedableFile): boolean {
  const a = createdAtMillis(candidate);
  const b = createdAtMillis(incumbent);
  if (a !== b) return a > b;
  return candidate.id < incumbent.id;
}

/**
 * The winner a file's ruling names, or null when the ruling must not be honored.
 *
 * Three ways a ruling is declined, and all three fail in the SAME direction - the file keeps
 * ranking - because the alternative is a lake silently contributing nothing for a subject:
 *
 *  - the winner is not in the scoped set (purged, removed from the lake, withheld mid-reindex);
 *  - the ruling points at the file itself;
 *  - following the chain of rulings comes back round to the file.
 *
 * The CYCLE case is the one that needs the walk rather than a self-check. The door refuses a ruling
 * whose winner is already ruled behind the loser, but rulings are made one finding at a time and
 * two curators - or one curator on two findings - can still close a loop that neither call could
 * see whole. Every file in a cycle would otherwise be suppressed by the next, and the subject would
 * leave the corpus entirely. Bounded by `byId.size` steps, so a malformed chain cannot spin.
 */
function resolveRuling<T extends SupersedableFile>(
  file: T,
  lakeId: string,
  byId: ReadonlyMap<string, T>
): string | null {
  const ruling = file.supersededInLakes?.find(r => r.dataLakeId === lakeId);
  if (!ruling) return null;

  // The IMMEDIATE winner must be in the scoped set; that is the inert-ruling guard, and it is the
  // only step for which leaving the set matters. A ruling is about this file and its winner, so a
  // winner that is itself ruled behind something out of scope is still a winner here.
  if (!byId.has(ruling.supersededByFabFileId)) return null;

  // Walk the rest purely to detect a loop back to this file. Leaving the scoped set ENDS the walk
  // without declining anything - an out-of-scope link cannot close a cycle.
  const seen = new Set<string>([file.id]);
  let current: string | undefined = ruling.supersededByFabFileId;
  while (current) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = byId.get(current)?.supersededInLakes?.find(r => r.dataLakeId === lakeId)?.supersededByFabFileId;
  }
  return ruling.supersededByFabFileId;
}

/**
 * Split a scoped file set into the newest generation of each source document and the older
 * generations it supersedes, PER LAKE. Pure; no I/O.
 *
 * Attribution comes from the resolved `lakes`, not from meta-tags alone, so a member carrying only
 * a content-tag prefix still groups - for a static-registry lake on the prefix alone, and for a
 * dynamic lake when its creator owns the file (see `attributeFileToLakeIds`). A file
 * that attributes to NO lake, or to more than one, groups only with itself and is never collapsed:
 * without a single owning lake there is no scope in which "the same document" is even well defined,
 * and the wrong answer here silently drops a document from retrieval.
 *
 * Two sources of suppression, checked in this order:
 *
 *  1. A CURATOR ruling on the file for its attributed lake (`supersededInLakes`), which wins
 *     outright. A human looked at the pair and said which is current; no derived key can overrule
 *     that, and a ruled file must not then go on to win an identity group and suppress a third
 *     member on the strength of a generation the curator just retired.
 *  2. The derived identity collapse, unchanged, and skipped entirely when `identityTiers` is false.
 *
 * `identityTiers` exists because the two halves warrant different defaults. The derived collapse
 * ships off by default at its forced-retrieval caller (`EnableRetrievalSupersessionCollapse`) -
 * its weakest tier is a bare file name and it can be wrong. A curator ruling carries no such
 * doubt, so it applies whether or not that setting is on, and the flag is what lets one caller ask
 * for the rulings alone. Defaults to true, so every existing caller is unchanged.
 *
 * A ruling is honored ONLY while its winner is in the scoped set. That is the same invariant the
 * callers already order their partitions around - a winner that cannot be served must never
 * suppress a sibling that can - and here it doubles as the retention guard: a winner that was
 * purged, removed from the lake or withheld mid-reindex leaves the ruling inert and the older
 * document ranking, rather than the lake silently contributing nothing for that subject. It is
 * also why no sweep chases stale rulings when a document is destroyed.
 *
 * Scope order is preserved in both outputs, so a caller's downstream sampling stays stable.
 */
export function partitionBySupersession<T extends SupersedableFile>(
  files: readonly T[],
  lakeScope: { lakes: readonly AttributableLake[]; identityTiers?: boolean }
): { servable: T[]; superseded: SupersededEntry<T>[] } {
  const lakes = [...lakeScope.lakes];
  const identityTiersEnabled = lakeScope.identityTiers ?? true;
  const byId = new Map(files.map(f => [f.id, f]));
  const winners = new Map<string, T>();
  const keyed: {
    file: T;
    identity: { key: string; tier: SupersessionTier } | null;
    ruledBy: string | null;
  }[] = [];

  for (const file of files) {
    const lakeIds = attributeFileToLakeIds(file.fileTags ?? [], lakes, file.userId);
    const lakeId = lakeIds.length === 1 ? lakeIds[0] : null;
    const ruledBy = lakeId ? resolveRuling(file, lakeId, byId) : null;
    const identity = !ruledBy && identityTiersEnabled && lakeId ? sourceIdentityKeyFor(file, lakeId) : null;
    keyed.push({ file, identity, ruledBy });
    if (!identity) continue;
    const incumbent = winners.get(identity.key);
    if (!incumbent || winsOver(file, incumbent)) winners.set(identity.key, file);
  }

  const servable: T[] = [];
  const superseded: SupersededEntry<T>[] = [];
  for (const { file, identity, ruledBy } of keyed) {
    if (ruledBy) {
      superseded.push({ file, tier: CURATOR_SUPERSESSION_TIER, supersededBy: ruledBy });
      continue;
    }
    const winner = identity && winners.get(identity.key);
    if (!winner || !identity || winner.id === file.id) servable.push(file);
    else superseded.push({ file, tier: identity.tier, supersededBy: winner.id });
  }
  return { servable, superseded };
}

export function buildSupersessionReport(superseded: readonly SupersededEntry[]): SupersessionReport {
  return {
    count: superseded.length,
    sample: superseded.slice(0, SAMPLE_CAP).map(e => ({
      fileId: e.file.id,
      fileName: e.file.fileName,
      tier: e.tier,
      supersededBy: e.supersededBy,
    })),
    partial: superseded.length > 0,
  };
}

/**
 * The named half of every supersession notice, shared so the search prose below and the forced
 * retrieval coverage in ChatCompletionFeatures stay worded alike. Names ids, not just a count, and
 * says which signal matched: the bare-filename tier can collapse two genuinely different documents,
 * and a reader can only tell that from the pair plus the tier.
 */
export function formatSupersededSample(sample: SupersessionReport['sample'], count: number): string {
  const named = sample
    .map(f => {
      // Ids are server-generated and safe unescaped; the NAME is not. This prose reaches the
      // column-0 `NOTE:` region, outside the block defangRetrievedContent guards - see the matching
      // note in retrievalUnavailable.ts, which sanitizes the same value for the sibling report.
      const label = f.fileName ? toSingleLine(f.fileName) : '';
      return `${label || f.fileId} [${f.fileId}, matched by ${f.tier}, superseded by ${f.supersededBy}]`;
    })
    .join('; ');
  return count > sample.length ? `${named}, ...` : named;
}

/** Prose for the API response, the chat NOTE and the quest warning. Null when nothing was suppressed. */
export function describeSupersession(report: SupersessionReport | undefined): string | null {
  if (!report?.partial) return null;
  // The recovery instruction is what makes the weak file-name tier acceptable at all - see the
  // module comment.
  // Deliberately NOT "a newer version of the same source document" any more. That was true when
  // every tier was a derived identity match, and is false for a `curator` entry: a curator rules on
  // two documents that CONTRADICT each other, which is the whole reason that tier exists, and they
  // are typically neither the same document nor ordered by age. The sample names the tier, so the
  // reader can tell which kind each one is rather than being told the wrong thing about all of them.
  return (
    `${report.count} document(s) were not ranked because this data lake holds a version that supersedes ` +
    'them - either a newer generation of the same source document, or a curator\'s explicit ruling ' +
    `(shown as "matched by curator"): ${formatSupersededSample(report.sample, report.count)}. They are still ` +
    'in the knowledge base - retrieve one by id or name if you need the superseded version specifically.'
  );
}
