import { attributeFileToLakeIds, type AttributableLake } from './attributeAccessedLakes';

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

// NUL-joined so a file name or path containing the separator cannot forge another file's key.
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

/** Newest wins; equal timestamps fall to ascending id so the choice never depends on scope order. */
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
 * Attribution comes from the resolved `lakes`, not from meta-tags alone, so a static-registry lake
 * whose members carry only a content-tag prefix still groups (see `attributeFileToLakeIds`). A file
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
    const lakeIds = attributeFileToLakeIds(file.fileTags ?? [], lakes);
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
    .map(f => `${f.fileName ?? f.fileId} [${f.fileId}, matched by ${f.tier}, superseded by ${f.supersededBy}]`)
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
