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
 * The identity key is deliberately PATH identity, not content identity. The case worth fixing is an
 * old generation plus a newer CORRECTED one, so their text differs by definition and a content-hash
 * corroboration would collapse only byte-identical duplicates - it would miss every interesting
 * case. Same source, different content is what a supersession looks like.
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
 * Which identity signal produced a group key, most to least trustworthy. Reported per collapse
 * because the weakest tier is the one that can be wrong (see the module comment).
 */
export type SupersessionTier = 'driveFileId' | 'relativePath' | 'fileName';

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

// NUL-joined: the lake id and the tier literal sit at fixed positions, so no value can forge a key
// belonging to another lake or another tier. Within one tier the join is not injective if a NUL is
// ever representable in a name (`a` + `b\0c` and `a\0b` + `c` agree), which costs nothing here -
// same lake, same owner, and the outcome is at worst one wrong collapse of the kind the file-name
// tier already permits.
const SEP = '\0';

/**
 * The group key for one file within one lake, first applicable tier wins. Null when the file has no
 * usable name at all, which means "groups only with itself".
 */
function supersessionKeyFor(file: SupersedableFile, lakeId: string): { key: string; tier: SupersessionTier } | null {
  if (file.driveFileId) {
    return { key: [lakeId, 'driveFileId', file.driveFileId].join(SEP), tier: 'driveFileId' };
  }
  if (!file.fileName) return null;
  if (file.relativePath) {
    return { key: [lakeId, 'relativePath', file.relativePath, file.fileName].join(SEP), tier: 'relativePath' };
  }
  return { key: [lakeId, 'fileName', file.fileName].join(SEP), tier: 'fileName' };
}

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
 * Scope order is preserved in both outputs, so a caller's downstream sampling stays stable.
 */
export function partitionBySupersession<T extends SupersedableFile>(
  files: readonly T[],
  lakeScope: { lakes: readonly AttributableLake[] }
): { servable: T[]; superseded: SupersededEntry<T>[] } {
  const lakes = [...lakeScope.lakes];
  const winners = new Map<string, T>();
  const keyed: { file: T; identity: { key: string; tier: SupersessionTier } | null }[] = [];

  for (const file of files) {
    const lakeIds = attributeFileToLakeIds(file.fileTags ?? [], lakes, file.userId);
    const identity = lakeIds.length === 1 ? supersessionKeyFor(file, lakeIds[0]) : null;
    keyed.push({ file, identity });
    if (!identity) continue;
    const incumbent = winners.get(identity.key);
    if (!incumbent || winsOver(file, incumbent)) winners.set(identity.key, file);
  }

  const servable: T[] = [];
  const superseded: SupersededEntry<T>[] = [];
  for (const { file, identity } of keyed) {
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
  return (
    `${report.count} older file version(s) were not ranked because the same data lake holds a newer ` +
    `version of the same source document: ${formatSupersededSample(report.sample, report.count)}. They are still ` +
    'in the knowledge base - retrieve one by id or name if you need the superseded version specifically.'
  );
}
