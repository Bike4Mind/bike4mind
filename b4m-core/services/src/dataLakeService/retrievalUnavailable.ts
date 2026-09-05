import {
  isChunkRebuildPending,
  isChunkStalledFile,
  isMemberIndexingInFlight,
  type ChunkStallReason,
} from '@bike4mind/common';
import { describeEmbeddingMismatch, type EmbeddingMismatchReport } from './embeddingMismatch';
import { toSingleLine } from './renderDataLakePromptBlock';
import { describeSupersession, type SupersessionReport } from './supersession';

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
   * `EmbeddingMismatchReport.partial`. For the `indexing` bucket it is transient in the ordinary
   * case and clears on its own, which is why it is safe to raise on an in-progress ingest as well as
   * on a convergence wave; for `paused` it never does. The one `indexing` member that does not clear
   * by itself is a rebuild whose enqueue was lost (#1939) - rare, and the prose names the action for
   * it rather than promising only time. Both buckets are the same fact for a reader - some of this
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
  /** Set when the convergence kill switch stalled the file (`FabFile.chunkStallReason`). */
  chunkStallReason?: ChunkStallReason | null;
  /**
   * The owner's own note. Read ONLY through `isChunkStalledFile`, as the transitional fallback for
   * rows #2016's migration has not reached yet - see its docblock in `common`. Nothing else here
   * may key on it, and it goes away with that arm.
   */
  notes?: string | null;
  /** A requested-but-uncommitted passage rebuild (#1939) - see the partition below. */
  chunkRebuildRequestedAt?: Date | string | null;
};

/**
 * Split a scoped file set into the files a search may rank and the files it must refuse.
 *
 * A file with no chunks at all is NOT withheld: it has nothing to contribute either way, and
 * flagging every image and every still-uploading row would fire the partial signal on healthy
 * lakes forever - the failure mode that teaches a reader to ignore the flag.
 *
 * The `chunkCount > 0` guard is what keeps images and pending uploads out, and it USED to route a
 * member being repaired to `servable` as well: `resetChunkStateByIds` sets `chunkCount: 0`, and that
 * reset touches FabFile DOCUMENT fields only - the chunk rows are deleted much later, inside
 * `commitFabFileChunks` - so across the reset -> queue -> claim -> tokenize span the member's old
 * vectorized chunks still existed and still ranked. That reading was defensible while the window was
 * short, and wrong in the case that matters: it is indistinguishable from a rebuild that was reset
 * and never enqueued, which never ends, and on a `vectorizedOnly` surface the file was dropped
 * upstream of this partition entirely, so the hole was not even served-stale - it was silent.
 *
 * So the pending stamp (#1939) overrides the guard: a member with a rebuild outstanding is withheld
 * and REPORTED as re-indexing. The cost is naming a file whose stale passages could still have been
 * ranked for the minutes between reset and commit; the prose below is worded to be true of that
 * member too. Refuse-and-report over degrade-silently, the same rule as everywhere else here.
 */
export function partitionByIndexAvailability<T extends IndexStateFile>(
  files: readonly T[]
): { servable: T[]; withheld: T[] } {
  const servable: T[] = [];
  const withheld: T[] = [];
  for (const file of files) {
    const chunkCount = file.chunkCount ?? 0;
    // The kill-switch EXCEPTION to the `chunkCount > 0` rule above: a file either arm of the switch
    // stalled has no SEARCHABLE passage even when it has chunks, so "nothing to contribute either
    // way" does not apply - it had content and the corpus now has a hole where it was. Withheld, so
    // the hole is reported rather than answered around.
    //
    // The condition is EITHER marker AND zero vectorized chunks, i.e. "marked stalled and nothing of
    // it is retrievable right now". Both halves are load-bearing, and each was a live defect:
    //
    // - Keying on the CHUNK arm alone served the vectorize arm, on the false premise that such a
    //   file "is served" and is "permanent". Neither holds. The search read path filters
    //   `vector: {$exists: true, $ne: []}`, so a file with 45 chunks and 0 vectors returns nothing
    //   while its neighbours are re-ranked into the top-K - measured live, the answer confidently
    //   contradicted the missing document. And reprocess repairs it in seconds, so it is repairable
    //   by the same prose the chunk arm already prints.
    // - Keying on the marker alone, with no vector condition, withheld a REPAIRED file forever: the
    //   rescue sweep enqueues without a reset, and nothing on that success path used to clear the
    //   marker, so a fully re-chunked and re-vectorized file kept it and stayed permanently
    //   unsearchable while every search on the lake reported partial.
    //
    // Splitting on the VECTOR COUNT rather than on which arm was stamped is what makes both
    // correct at once, and it keeps the one case that genuinely is servable servable: a partially
    // vectorized file (40 of 90) really does return its embedded passages, so it ranks normally.
    //
    // A null count (predates the field) is read as zero and withheld: with the marker present we
    // cannot show anything is retrievable, and this feature's rule is refuse-and-report over
    // degrade-silently. `commitFabFileChunks` clearing the marker on a successful rebuild is the
    // other half of this - see the note there; this guard is what holds if that write is lost.
    const hasNoRetrievablePassage = (file.vectorizedChunkCount ?? 0) === 0;
    // The pending stamp widens the `chunkCount > 0` guard rather than replacing it: it is the one
    // in-flight signal that fires on a CHUNKLESS member, and `isMemberIndexingInFlight` is still what
    // decides (so `error` and the stall reason keep their precedence there, and a stamp left behind by
    // a rebuild that stopped does not read as one still running).
    const rebuildPending = isChunkRebuildPending(file.chunkRebuildRequestedAt);
    if (isChunkStalledFile(file) && hasNoRetrievablePassage) withheld.push(file);
    else if ((chunkCount > 0 || rebuildPending) && isMemberIndexingInFlight({ ...file, chunkCount }))
      withheld.push(file);
    else servable.push(file);
  }
  return { servable, withheld };
}

const nameSample = (files: readonly IndexStateFile[]) =>
  files.slice(0, SAMPLE_CAP).map(f => ({ fileId: f.id, fileName: f.fileName }));

export function buildRetrievalUnavailableReport(withheld: readonly IndexStateFile[]): RetrievalUnavailableReport {
  // Split on "was the kill switch what stopped this", not on chunk count and not on WHICH arm: the
  // two buckets differ only in whether waiting fixes them, and that is exactly what the prose below
  // tells the reader to do. Both arms are alike on that point and neither auto-resumes - a dropped
  // vectorize message has no producer that will re-send it - so bucketing the vectorize arm as
  // `indexing` would print "they will return on their own" about a file that never will.
  const paused = withheld.filter(f => isChunkStalledFile(f));
  const indexing = withheld.filter(f => !isChunkStalledFile(f));
  return {
    indexing: { count: indexing.length, sample: nameSample(indexing) },
    paused: { count: paused.length, sample: nameSample(paused) },
    partial: withheld.length > 0,
  };
}

/** Prose for the API response, the chat status line and the quest warning. Null when nothing was withheld. */
export function describeRetrievalUnavailable(report: RetrievalUnavailableReport | undefined): string | null {
  if (!report?.partial) return null;

  // toSingleLine (toContentLabel at the prompt sinks) because these names are attacker-influenced
  // and this prose lands in the column-0 `NOTE:` region of a tool result, OUTSIDE the untrusted
  // block that defangRetrievedContent guards - so a name carrying a line break plus a forged marker
  // would be read as our framing. Same defense the passage headers already apply to the same value.
  const namesOf = (bucket: { count: number; sample: { fileName?: string }[] }) => {
    const names = bucket.sample
      .map(f => f.fileName)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .map(toSingleLine);
    return names.length > 0 ? ` (${names.join(', ')}${bucket.count > names.length ? ', ...' : ''})` : '';
  };

  const sentences: string[] = [];
  if (report.indexing.count > 0) {
    // States the remedy is TIME, not an action: the reader must not be sent to re-embed a file that
    // is already re-embedding. Worded as "being replaced" rather than "no longer exist" because a
    // member reset but not yet committed still has its old chunk rows (#1939) - the claim has to be
    // true of the earliest point in the window as well as the rest of it.
    //
    // The trailing sentence is what keeps "returns on its own" from being a FALSE promise. A pending
    // rebuild whose enqueue never landed (a producer killed between the reset and its sends) is
    // withheld here indefinitely, and nothing brings it back until the rescue sweep runs or someone
    // rebuilds the lake - so a bare "wait and re-run" would be exactly the wrong instruction, the
    // same failure the `paused` bucket below exists to avoid. Stated as a CONDITIONAL escape hatch
    // rather than by re-bucketing a stale stamp as `paused`: the two states differ in what a reader
    // should do FIRST (wait vs act), which is what these buckets encode, and this keeps that split
    // honest without giving a pure reporting function a clock or `paused` a cause it does not have.
    sentences.push(
      `Partial knowledge-base results: ${report.indexing.count} file(s)${namesOf(report.indexing)} are being ` +
        're-indexed right now and were withheld - their passages are being replaced and the replacements are ' +
        'not searchable yet. They return on their own once indexing completes; re-run the search then. If they ' +
        'are still missing much later, the rebuild did not finish - use the lake\'s "Rebuild passages" action, ' +
        'or reprocess the files individually.'
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
    // (detectUnderChunkedFiles) selects these members by the same marker, on any lake, for BOTH arms.
    //
    // Worded for both arms deliberately. The chunk arm's passages were deleted; the vectorize arm's
    // exist but carry no vector, and the search read path requires one - so "no searchable passages
    // at all" is literally true of both, while naming the re-chunk specifically was true of one.
    // The repair leads and the admin action is CONDITIONAL, in that order, because the marker outlives
    // the pause that caused it: the switch is often already back off by the time anyone reads this
    // (QA hit exactly that - a marker acquired around a pause flip, then read minutes later against a
    // switch confirmed off). Leading with "an administrator has to resume convergence" pointed the
    // reader at a control that was already in the right position, leaving the one action that always
    // works buried in a trailing clause. Rebuilding passages is policy-independent and works on any
    // lake, so it is the honest primary instruction.
    sentences.push(
      `${report.paused.count} file(s)${namesOf(report.paused)} have no searchable passages at all: re-processing ` +
        'them was paused partway, so they were withheld. Unlike re-indexing files these do NOT return on ' +
        'their own - use the lake\'s "Rebuild passages" action, or reprocess the files individually, to ' +
        'restore them. If background lake work is still paused, an administrator has to resume it first.'
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
  supersession?: SupersessionReport;
  embeddingModel: string;
}): string | null {
  const sentences = [
    describeEmbeddingMismatch(search.embeddingMismatch, search.embeddingModel),
    describeRetrievalUnavailable(search.retrievalUnavailable),
    describeSupersession(search.supersession),
  ].filter((s): s is string => s !== null);
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/**
 * Whether a search returned a partial corpus for ANY reason - the flag a wire contract exposes.
 *
 * Deliberately NOT widened to `supersession`, even though that report is part of the wording seam
 * above. The two existing reasons mean "content that should have been comparable/servable was not",
 * which is abnormal and repairable; a supersession means "we deliberately ranked one of two
 * generations", which is permanent and is the steady state of any lake holding a re-uploaded
 * document. Counting it here would raise `partial` on every search against a healthy lake forever,
 * which is exactly how a reader learns to ignore the flag (see the module comment at the top). A
 * reader who needs to KNOW still gets the prose from `describeSearchLimitations`.
 */
export function isPartialSearch(search: {
  embeddingMismatch?: EmbeddingMismatchReport;
  retrievalUnavailable?: RetrievalUnavailableReport;
}): boolean {
  return Boolean(search.embeddingMismatch?.partial || search.retrievalUnavailable?.partial);
}
