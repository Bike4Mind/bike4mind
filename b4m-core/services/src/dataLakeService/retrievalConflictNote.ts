import {
  detectCorpusInconsistencies,
  DISAGREEMENT_INCONSISTENCY_KINDS,
  type CorpusDocument,
  type InconsistencyKind,
} from '@bike4mind/common';

/**
 * Retrieval-time cross-document conflict note.
 *
 * When a single retrieval call pools passages from several documents, two of them can flatly
 * disagree - the same metric at two values - and the model sees both claims with equal authority and
 * no signal that they conflict. It picks one, usually the highest-ranked, and answers confidently.
 *
 * This runs the existing corpus detector over the handful of passages a call already holds in memory
 * (no DB read, no LLM call) and turns a non-empty result into a note the caller concatenates at
 * column 0, OUTSIDE the untrusted content block. Sibling of renderRetrievedContentBlock.ts: shared by
 * all three retrieval channels so the wording and the leak-safety decision cannot drift apart.
 *
 * Distinct surface from detectLakeInconsistencies.ts, which shares the same rule engine but is an
 * async, stored, admin-facing whole-lake health scan. That surface OFFERS a finding to a human who
 * triages it, so it wants every rule's recall; this one ASSERTS disagreement to a model that cannot
 * check it, so it keeps only the findings whose kind can carry an assertion. Every rule still runs;
 * the classification is DISAGREEMENT_INCONSISTENCY_KINDS, which lives beside the rules in common.
 * Do not route one surface through the other, and do not widen that list to match the scan's.
 */

/** One passage as a retrieval channel already holds it: the id it will attribute, the text it will render. */
export interface RetrievalPassage {
  fabFileId: string;
  /**
   * The text the site actually RENDERS - post-budget-clip, and post-defang where the site defangs
   * before slicing. A note citing evidence the model cannot see would be worse than no note. Pre- vs
   * post-defang is immaterial: defang only indents line-initial markers and the detector trims every
   * sentence it splits out.
   */
  text: string;
}

/**
 * Documents named before the list degrades to "and at least N more". Keeps the note a bounded length.
 */
export const RETRIEVAL_CONFLICT_MAX_IDS = 10;

/**
 * Defensive ceiling on text swept per call. Every site today is bounded well under this by its own
 * char budget, so this never fires - it exists so a future budget increase cannot put an unbounded
 * regex sweep on the hot chat path. Biased toward the first documents: once the ceiling is reached
 * the remaining documents are dropped whole rather than sampled, so a future budget rise would cost
 * recall silently rather than loudly.
 */
export const RETRIEVAL_CONFLICT_MAX_CHARS = 120_000;

/** Marker the site tests slice on, and the prefix `defangRetrievedContent` already indents inside content. */
const NOTE_OPENING = 'NOTE: the retrieved documents below may contradict each other.';

/**
 * A column-0 note when the passages of ONE retrieval call disagree across documents, or '' when they
 * do not. The caller concatenates it alongside its other notes, outside the untrusted content block.
 *
 * Renders `fabFileId`, counts, and our own `kind` vocabulary only. `subject`, `excerpt` and `fileName`
 * are all derived from document prose - a crafted one could carry a forged marker into our own
 * framing - so none of them may ever appear here. `fabFileId` is MongoDB-generated and rendered by
 * every channel as `(ID: ...)`, so it needs no `toContentLabel` and the model can find the passages
 * it names.
 *
 * Runs with `metricUnitRequired`, which is what keeps the note honest about a passage the caller
 * clipped to a budget. Every site cuts with a raw `slice`, so a passage can end mid-number - and a
 * bare `1,2` surviving from `1,200,000` would otherwise read as disagreeing with the document stating
 * the full figure. The unit follows the value, so any cut INSIDE the value takes the unit with it and
 * the fragment stops being a metric at all.
 *
 * The residual, unfixed: a cut inside the unit WORD can truncate it into a shorter valid unit -
 * `5 gbps` clipped to `5 gb`, `30 sprints` to `30 s`. That needs one exact offset per such token
 * rather than any offset inside a number, and the code fix (drop a trailing metric whose unit abuts
 * end-of-string) would re-cost the recall on unterminated bullet text that requiring a unit just
 * bought back. Known and accepted, not overlooked.
 *
 * `nowYear` is a parameter for the same reason the detector takes one: reproducibility under test.
 */
export function buildRetrievalConflictNote(
  passages: RetrievalPassage[],
  nowYear: number = new Date().getUTCFullYear()
): string {
  const identified = passages.filter(p => p.fabFileId);
  // The common case on the hot path: one document cannot disagree with itself across documents, so
  // return before paying for the regex sweep.
  if (new Set(identified.map(p => p.fabFileId)).size < 2) return '';

  // One CorpusDocument per passage. Not per document: the detector already groups by `fabFileId` and
  // keeps one excerpt per document, so merging a document's passages here would change nothing.
  // `fileName` is deliberately not carried - it is never rendered, so there is nothing for it to
  // leak out of.
  const documents: CorpusDocument[] = [];
  let chars = 0;
  for (const { fabFileId, text } of identified) {
    const remaining = RETRIEVAL_CONFLICT_MAX_CHARS - chars;
    if (remaining <= 0) break;
    documents.push({ fabFileId, text: text.length > remaining ? text.slice(0, remaining) : text });
    chars += Math.min(text.length, remaining);
  }

  const { findings } = detectCorpusInconsistencies(documents, { nowYear, metricUnitRequired: true });
  // `documentCount >= 2` is already guaranteed by the cross-document rules; asserted again here so a
  // future kind joining DISAGREEMENT_INCONSISTENCY_KINDS cannot emit a single-document "disagreement".
  const asserted: readonly InconsistencyKind[] = DISAGREEMENT_INCONSISTENCY_KINDS;
  const kept = findings.filter(f => asserted.includes(f.kind) && f.documentCount >= 2);
  if (kept.length === 0) return '';

  // Order is the detector's kind order, so the term list is fixed rather than incidental.
  const kindTerms = asserted
    .map(kind => ({
      kind,
      count: kept.filter(f => f.kind === kind).length,
    }))
    .filter(t => t.count > 0)
    .map(t => `${t.kind}: ${t.count}`)
    .join(', ');

  const ids = [...new Set(kept.flatMap(f => f.evidence.map(e => e.fabFileId)))];
  const overflow = ids.length - RETRIEVAL_CONFLICT_MAX_IDS;
  // "at least": `evidence` is itself capped upstream, so a finding spanning more documents than that
  // cap contributes no id for them and the overflow here is a lower bound on the unnamed.
  const idList =
    overflow > 0
      ? `${ids.slice(0, RETRIEVAL_CONFLICT_MAX_IDS).join(', ')}, and at least ${overflow} more`
      : ids.join(', ');

  return (
    `${NOTE_OPENING} ${kept.length} cross-document conflict(s) detected (${kindTerms}) across documents ` +
    `${idList}. These are heuristic pattern matches over the passage text, not proven contradictions - ` +
    'the same label can be measured over a different scope in each document. Read the passages before ' +
    'relying on either: if they really do disagree, say so rather than silently picking one side, attribute ' +
    'each conflicting claim to the document it came from, and say which one you relied on and why.\n\n'
  );
}
