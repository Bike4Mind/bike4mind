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
 * Documents named before the list degrades to "and at least N more". Keeps the note a bounded length,
 * and bounds the grouped form too: past it the note states one flat list rather than the pairings.
 */
const RETRIEVAL_CONFLICT_MAX_IDS = 10;

/**
 * `nowYear` is inert here: the only rule reading it is `expired-claim`, which this surface filters
 * out (see DISAGREEMENT_INCONSISTENCY_KINDS). The detector's parameter is not optional, so a value
 * must be passed, and a literal keeps this surface off the clock - the convention the detector and
 * detectLakeInconsistencies.ts both state, so that a finding never depends on when it was computed.
 *
 * Past the end of `DATED_CLAIM`'s own `(19|20)\d{2}` range on purpose, so every dated claim reads as
 * expired and the kind filter stays exercised. A year in the PAST would be equally inert, by
 * producing no such finding for the filter to drop - and would make a test of that filter vacuous.
 * If a date-bearing kind ever joins the asserted list this has to become a caller-supplied year.
 */
export const ALL_DATED_CLAIMS_EXPIRED_YEAR = 9999;

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
 * The residual is `METRIC`'s own, recorded beside the rule: a cut landing inside the unit WORD can
 * shorten it into another valid unit. It needs one exact offset per such token rather than any offset
 * inside a number, and the code fix here (drop a trailing metric whose unit abuts end-of-string) would
 * re-cost the recall on unterminated bullet text that requiring a unit just bought back.
 */
export function buildRetrievalConflictNote(passages: RetrievalPassage[]): string {
  const identified = passages.filter(p => p.fabFileId);
  // The common case on the hot path: one document cannot disagree with itself across documents, so
  // return before paying for the regex sweep. Behaviourally redundant - the detector's own
  // cross-document requirement drops the same input - so no test can see it, only a profiler.
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

  const { findings } = detectCorpusInconsistencies(documents, {
    nowYear: ALL_DATED_CLAIMS_EXPIRED_YEAR,
    metricUnitRequired: true,
  });
  // A widening, not a rename: `.includes` on the source tuple only accepts its own member type.
  const asserted: readonly InconsistencyKind[] = DISAGREEMENT_INCONSISTENCY_KINDS;
  // `documentCount >= 2` is already guaranteed by the cross-document rules; asserted again here so a
  // future kind joining DISAGREEMENT_INCONSISTENCY_KINDS cannot emit a single-document "disagreement".
  const kept = findings.filter(f => asserted.includes(f.kind) && f.documentCount >= 2);
  if (kept.length === 0) return '';

  // Order is the detector's kind order, so the term list is fixed rather than incidental. A per-kind
  // count with only one kind in the list restates the headline count, so it is omitted there - which
  // is every note today, since the asserted list has one member. The counted arm is the growth path:
  // a second asserted kind makes it reachable without a caller having to notice.
  const terms = asserted
    .map(kind => ({
      kind,
      count: kept.filter(f => f.kind === kind).length,
    }))
    .filter(t => t.count > 0);
  const kindTerms = terms.length === 1 ? terms[0].kind : terms.map(t => `${t.kind}: ${t.count}`).join(', ');

  // Ids in the order the channel serves the passages, so the model reads them against the block below
  // rather than against the detector's internal grouping.
  const rank = new Map<string, number>();
  for (const { fabFileId } of identified) if (!rank.has(fabFileId)) rank.set(fabFileId, rank.size);
  const byRank = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);

  // One group per finding, deduped by membership: two conflicts over DISJOINT document pairs must not
  // read as one list of four documents that all disagree with each other. Six subjects over the SAME
  // pair is one relationship to state, not six, which is what the dedup collapses.
  // Groups themselves in serve order too: the detector orders findings by kind and subject, which is
  // its own internal order and not one the model can see anything against.
  //
  // The witness PAIR only, not every document in the finding. `witnessOrder` puts two documents that
  // provably hold different values at evidence[0] and evidence[1]; the rest of the group merely
  // mentioned the same subject, and on the ordinary 3-agree-1-dissents shape naming all four asserts
  // a mutual contradiction that does not exist. The model reads the passages either way - what the
  // note owes it is a claim narrow enough to be true.
  const groups = [
    ...new Map(
      kept.map(finding => {
        const group = [...new Set(finding.evidence.slice(0, 2).map(e => e.fabFileId))].sort(byRank);
        return [group.join(','), group] as const;
      })
    ).values(),
  ].sort((a, b) => byRank(a[0], b[0]));

  const ids = [...new Set(groups.flat())].sort(byRank);
  const overflow = ids.length - RETRIEVAL_CONFLICT_MAX_IDS;
  // "at least": `evidence` is itself capped upstream, so a finding spanning more documents than that
  // cap contributes no id for them and the overflow here is a lower bound on the unnamed. Past either
  // bound the flat list is the bounded form, and the count clause still says the conflicts are separate.
  const idList =
    overflow > 0
      ? `${ids.slice(0, RETRIEVAL_CONFLICT_MAX_IDS).join(', ')}, and at least ${overflow} more`
      : groups.length > 1 && groups.flat().length <= RETRIEVAL_CONFLICT_MAX_IDS
        ? groups.map(group => `(${group.join(', ')})`).join(' and ')
        : ids.join(', ');

  const conflicts = `${kept.length} cross-document ${kept.length === 1 ? 'conflict' : 'conflicts'}`;
  return (
    `${NOTE_OPENING} ${conflicts} detected (${kindTerms}) across documents ` +
    `${idList}. These are heuristic pattern matches over the passage text, not proven contradictions - ` +
    'the same label can be measured over a different scope in each document. Read the passages before ' +
    'relying on any of them: if they really do disagree, say so rather than silently picking one side, ' +
    'attribute each conflicting claim to the document it came from using whatever citation style this ' +
    'context already specifies, and say which one you relied on and why.\n\n'
  );
}
