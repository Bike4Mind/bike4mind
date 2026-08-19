import { CONVERGENCE_PAUSED_CHUNK_NOTE, isMemberIndexingInFlight } from '@bike4mind/common';
import { describeEmbeddingMismatch, type EmbeddingMismatchReport } from './embeddingMismatch';

/**
 * Content that is in scope and authorized but temporarily UNSERVABLE, because it is mid-(re)index.
 *
 * This is the retrieval half of #1681's first constraint. A re-chunk - whether an owner-triggered
 * convergence wave, a manual reprocess or a first ingest - deletes the file's chunk rows and
 * reinserts rows carrying NO vector, and every semantic read path filters
 * `vector: {$exists: true, $ne: []}`. So from the moment the write commits until the file's LAST
 * chunk embeds, the file contributes nothing, and its previous vectors are already gone: "serve
 * stale" is not an option the schema offers.
 *
 * Left unreported, that is silent degradation of the worst kind - the file simply is not there,
 * neighbouring chunks are re-ranked into the top-K, and the model answers confidently from a corpus
 * with a hole in it. So the file is REFUSED explicitly and the result set is marked partial.
 *
 * Deliberately a separate report from `EmbeddingMismatchReport` rather than another field on it:
 * that module answers "was what we looked at in the query's embedding space", a question about
 * comparability, and this one answers "is the content there to look at at all". Conflating them
 * would make `partial` mean two things and make neither actionable. `describeSearchLimitations`
 * below is the single wording seam callers use, so they still ask one question.
 */

/** How many withheld files to name, so a caller can act without dumping the lake. */
const SAMPLE_CAP = 5;

export interface RetrievalUnavailableReport {
  /** Files withheld because their (re)indexing has not settled. */
  indexing: {
    count: number;
    /** Named files, capped; the count above is always exact. */
    sample: { fileId: string; fileName?: string }[];
  };
  /**
   * Files whose passages a convergence wave DELETED and the kill switch then stopped from being
   * rebuilt. Reported apart from `indexing` because the remedy is the opposite: indexing clears on
   * its own and the reader should just search again later, while this one never does - it needs
   * convergence resumed or the file reprocessed. Telling a reader to wait would be wrong advice,
   * which is the whole reason this is not folded into the count above.
   */
  paused: {
    count: number;
    sample: { fileId: string; fileName?: string }[];
  };
  /**
   * True when content was withheld here - the single flag a consumer branches on, alongside
   * `EmbeddingMismatchReport.partial`. For the `indexing` bucket it is TRANSIENT and clears on its
   * own, which is why it is safe to raise on an ordinary in-progress ingest as well as on a
   * convergence wave; for `paused` it does not. Both are the same fact for a reader - some of this
   * lake is not searchable right now - so they share the flag, and the prose says which is which.
   */
  partial: boolean;
}

export function emptyRetrievalUnavailableReport(): RetrievalUnavailableReport {
  return { indexing: { count: 0, sample: [] }, paused: { count: 0, sample: [] }, partial: false };
}

/** The per-file facts the refusal reads. A subset of the rollups health and convergence also grade. */
export type IndexStateFile = {
  id: string;
  fileName?: string;
  chunkCount?: number;
  vectorizedChunkCount?: number | null;
  error?: string | null;
  notes?: string | null;
};

/**
 * Split a scoped file set into the files a search may rank and the files it must refuse.
 *
 * A file with no chunks at all is NOT withheld: it has nothing to contribute either way, and
 * flagging every image and every still-uploading row would fire the partial signal on healthy
 * lakes forever - the failure mode that teaches a reader to ignore the flag.
 *
 * That `chunkCount > 0` guard looks like a hole for convergence and is not one, but only because of
 * an invariant elsewhere - stated here because nothing local would fail if it changed. Convergence's
 * `resetChunkStateByIds` sets `chunkCount: 0`, which routes a member being repaired to `servable`;
 * it is not silently absent, because that reset touches FabFile DOCUMENT fields only. The chunk rows
 * are deleted much later, inside `commitFabFileChunks`. So across the whole reset -> queue -> claim
 * -> tokenize span the member's previous vectorized chunks still exist and still rank normally: it
 * serves stale-but-real passages, and becomes withheld only once the commit lands and `chunkCount`
 * is positive with `vectorizedChunkCount` behind it. That is the better outcome, and it depends on
 * the reset never deleting chunk rows - keep the two in sync.
 */
export function partitionByIndexAvailability<T extends IndexStateFile>(
  files: readonly T[]
): { servable: T[]; withheld: T[] } {
  const servable: T[] = [];
  const withheld: T[] = [];
  for (const file of files) {
    const chunkCount = file.chunkCount ?? 0;
    // The chunkless EXCEPTION: a file the kill switch stalled mid-RE-CHUNK has no chunks because its
    // own were deleted, so the "nothing to contribute either way" reasoning above does not apply -
    // it had content and the corpus now has a hole where it was. Withheld, so the hole is reported
    // rather than answered around.
    //
    // Deliberately the CHUNK marker only, not `isConvergencePausedNote`. The vectorize arm of the
    // same switch leaves a file with chunks but no vectors, and the decision there is to SERVE it
    // (see the terminally-failed reasoning above): it is permanent, so withholding would mark every
    // search on that lake partial forever. This one is different on the point that reasoning turns
    // on - it is repairable, and the prose below names the repair.
    if (file.notes === CONVERGENCE_PAUSED_CHUNK_NOTE) withheld.push(file);
    else if (chunkCount > 0 && isMemberIndexingInFlight({ ...file, chunkCount })) withheld.push(file);
    else servable.push(file);
  }
  return { servable, withheld };
}

const nameSample = (files: readonly IndexStateFile[]) =>
  files.slice(0, SAMPLE_CAP).map(f => ({ fileId: f.id, fileName: f.fileName }));

export function buildRetrievalUnavailableReport(withheld: readonly IndexStateFile[]): RetrievalUnavailableReport {
  // Split by the marker, not by chunk count: the two buckets differ only in whether waiting fixes
  // them, and that is exactly what the prose below tells the reader to do.
  const paused = withheld.filter(f => f.notes === CONVERGENCE_PAUSED_CHUNK_NOTE);
  const indexing = withheld.filter(f => f.notes !== CONVERGENCE_PAUSED_CHUNK_NOTE);
  return {
    indexing: { count: indexing.length, sample: nameSample(indexing) },
    paused: { count: paused.length, sample: nameSample(paused) },
    partial: withheld.length > 0,
  };
}

/** Prose for the API response, the chat status line and the quest warning. Null when nothing was withheld. */
export function describeRetrievalUnavailable(report: RetrievalUnavailableReport | undefined): string | null {
  if (!report?.partial) return null;

  const namesOf = (bucket: { count: number; sample: { fileName?: string }[] }) => {
    const names = bucket.sample.map(f => f.fileName).filter((n): n is string => typeof n === 'string' && n.length > 0);
    return names.length > 0 ? ` (${names.join(', ')}${bucket.count > names.length ? ', ...' : ''})` : '';
  };

  const sentences: string[] = [];
  if (report.indexing.count > 0) {
    // States the remedy is TIME, not an action: the reader must not be sent to re-embed a file that
    // is already re-embedding.
    sentences.push(
      `Partial knowledge-base results: ${report.indexing.count} file(s)${namesOf(report.indexing)} are being ` +
        're-indexed right now and were withheld - their previous passages no longer exist and their new ones are ' +
        'not searchable yet. They will return on their own once indexing completes; re-run the search then.'
    );
  }
  if (report.paused.count > 0) {
    // The opposite remedy, stated as such. These do NOT come back on their own, so the one thing
    // this must not do is tell the reader to wait - that is how a permanently absent document reads
    // as a temporary blip for as long as nobody checks.
    //
    // Both repairs it names are reachable independently of the lake's chunk policy, which is what
    // keeps this promise honest: convergence refuses a lake whose policy is inherited, so clearing
    // `requiredPassageTokenTarget` would otherwise retract the only repair while this text went on
    // advertising one. "Reprocessed" is the policy-independent door - "Rebuild passages"
    // (detectUnderChunkedFiles) selects these members by the same marker, on any lake.
    sentences.push(
      `${report.paused.count} file(s)${namesOf(report.paused)} have no searchable passages at all: a re-chunk ` +
        'removed them and was then paused, so they were withheld. Unlike re-indexing files these do NOT return on ' +
        'their own - an administrator has to resume convergence, or the files have to be reprocessed.'
    );
  }
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/**
 * THE wording seam for "this search returned less than the whole corpus", across both reasons.
 * Callers ask this one question instead of remembering which reports exist, so adding a third
 * limitation later reaches every surface without touching any of them.
 */
export function describeSearchLimitations(search: {
  embeddingMismatch?: EmbeddingMismatchReport;
  retrievalUnavailable?: RetrievalUnavailableReport;
  embeddingModel: string;
}): string | null {
  const sentences = [
    describeEmbeddingMismatch(search.embeddingMismatch, search.embeddingModel),
    describeRetrievalUnavailable(search.retrievalUnavailable),
  ].filter((s): s is string => s !== null);
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/** Whether a search returned a partial corpus for ANY reason - the flag a wire contract exposes. */
export function isPartialSearch(search: {
  embeddingMismatch?: EmbeddingMismatchReport;
  retrievalUnavailable?: RetrievalUnavailableReport;
}): boolean {
  return Boolean(search.embeddingMismatch?.partial || search.retrievalUnavailable?.partial);
}
