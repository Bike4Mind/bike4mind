import { isMemberIndexingInFlight } from '@bike4mind/common';
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
   * True when content was withheld here - the single flag a consumer branches on, alongside
   * `EmbeddingMismatchReport.partial`. Unlike that flag this one is inherently TRANSIENT: it
   * clears on its own as indexing completes, which is why it is safe to raise on an ordinary
   * in-progress ingest as well as on a convergence wave. Both are the same fact for a reader - some
   * of this lake is not searchable right now.
   */
  partial: boolean;
}

export function emptyRetrievalUnavailableReport(): RetrievalUnavailableReport {
  return { indexing: { count: 0, sample: [] }, partial: false };
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
 */
export function partitionByIndexAvailability<T extends IndexStateFile>(
  files: readonly T[]
): { servable: T[]; withheld: T[] } {
  const servable: T[] = [];
  const withheld: T[] = [];
  for (const file of files) {
    const chunkCount = file.chunkCount ?? 0;
    if (chunkCount > 0 && isMemberIndexingInFlight({ ...file, chunkCount })) withheld.push(file);
    else servable.push(file);
  }
  return { servable, withheld };
}

export function buildRetrievalUnavailableReport(withheld: readonly IndexStateFile[]): RetrievalUnavailableReport {
  return {
    indexing: {
      count: withheld.length,
      sample: withheld.slice(0, SAMPLE_CAP).map(f => ({ fileId: f.id, fileName: f.fileName })),
    },
    partial: withheld.length > 0,
  };
}

/** Prose for the API response, the chat status line and the quest warning. Null when nothing was withheld. */
export function describeRetrievalUnavailable(report: RetrievalUnavailableReport | undefined): string | null {
  if (!report?.partial) return null;
  const names = report.indexing.sample
    .map(f => f.fileName)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const named = names.length > 0 ? ` (${names.join(', ')}${report.indexing.count > names.length ? ', ...' : ''})` : '';
  // States the remedy is TIME, not an action: the reader must not be sent to re-embed a file that
  // is already re-embedding.
  return (
    `Partial knowledge-base results: ${report.indexing.count} file(s)${named} are being re-indexed right now and ` +
    'were withheld - their previous passages no longer exist and their new ones are not searchable yet. ' +
    'They will return on their own once indexing completes; re-run the search then.'
  );
}

/**
 * THE wording seam for "this search returned less than the whole corpus", across both reasons.
 * Callers ask this one question instead of remembering which reports exist, so adding a third
 * limitation later reaches every surface without touching any of them.
 */
export function describeSearchLimitations(
  search: {
    embeddingMismatch?: EmbeddingMismatchReport;
    retrievalUnavailable?: RetrievalUnavailableReport;
    embeddingModel: string;
  }
): string | null {
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
